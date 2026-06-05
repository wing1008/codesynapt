#!/usr/bin/env node
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { Scanner } from './packages/core/scanner.js'

// ─── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log(`
codesynapt — Real-time 3D file/code dependency visualizer

Usage:
  codesynapt <directory> [--port <n>]

Examples:
  codesynapt .
  codesynapt ~/projects/myapp --port 8080
`)
  process.exit(0)
}

const portIdx = args.indexOf('--port')
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 7777
const dirArg = args.find((a) => !a.startsWith('--') && a !== String(PORT)) || '.'
const ROOT = path.resolve(dirArg)

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`✗ Not a directory: ${ROOT}`)
  process.exit(1)
}

// ─── Static file server ───────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(__dirname, 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

// Robust containment check — `startsWith` alone leaks sibling dirs that share
// a prefix (e.g. /a/public vs /a/public-secret). Resolve and use path.relative.
const isInside = (base, target) => {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// ─── Origin / Host hardening (cross-origin + DNS-rebinding defense) ──
// This dev server binds to loopback, but loopback binding does NOT protect
// against a malicious web page the developer visits: browser fetch()/WebSocket
// run in the victim's browser and can target ws://127.0.0.1 / http://127.0.0.1
// regardless of the page's own origin. We therefore enforce:
//   1. Host header must be loopback (blocks DNS-rebinding: attacker.com→127.0.0.1)
//   2. Origin header (when present) must be loopback or file:// (blocks any
//      cross-origin browser page from connecting / reading files)
// CLI / non-browser clients send no Origin header and are unaffected.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', ''])

const hostIsLoopback = (req) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase()
  return LOOPBACK_HOSTS.has(host)
}

const originIsAllowed = (req) => {
  const origin = req.headers.origin
  // No Origin header → not a browser cross-origin request (CLI, curl, ws tools).
  if (origin === undefined || origin === null || origin === '') return true
  if (origin === 'null') return true // file:// pages and some sandboxes send "null"
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  if (parsed.protocol === 'file:') return true
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
}

// Dotfile / secret allowlist for read_file. Source-tree visualization never
// needs to display .env/.git internals/credentials, and a cross-origin or
// compromised client must not be able to exfiltrate them even within ROOT.
// Block any path segment that begins with a dot (covers .env, .env.local,
// .git/*, .npmrc, .ssh, .aws, etc.).
const isDotfilePath = (relId) => {
  const norm = String(relId).replace(/\\/g, '/')
  return norm.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')
}

const server = http.createServer((req, res) => {
  // DNS-rebinding defense: reject non-loopback Host headers.
  if (!hostIsLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('forbidden host')
    return
  }
  let rel = req.url.split('?')[0]
  try { rel = decodeURIComponent(rel) } catch {}   // normalize %2e%2e etc.
  if (rel === '/') rel = '/index.html'
  const filePath = path.join(PUBLIC, rel)
  if (!isInside(PUBLIC, filePath)) {
    res.writeHead(403); res.end(); return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' })
    res.end(data)
  })
})

// ─── WebSocket ────────────────────────────────────────────────
// verifyClient runs during the HTTP Upgrade handshake. Reject any connection
// whose Origin is cross-origin (a malicious page in the victim's browser) or
// whose Host header isn't loopback (DNS-rebinding). Same-origin localhost UI
// use sends Origin: http://localhost:<port> (or 127.0.0.1) and is allowed.
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    if (!hostIsLoopback(info.req)) return false
    if (!originIsAllowed(info.req)) return false
    return true
  },
})
const scanner = new Scanner(ROOT)

const broadcast = (msg) => {
  const str = JSON.stringify(msg)
  wss.clients.forEach((c) => c.readyState === 1 && c.send(str))
}

scanner.on('snapshot', (data) => broadcast({ type: 'snapshot', ...data, root: ROOT }))
scanner.on('stats', (s) => broadcast({ type: 'stats', ...s }))
scanner.on('scan-progress', (p) => broadcast({ type: 'scan-progress', ...p }))

wss.on('connection', (ws) => {
  // New client gets current state
  ws.send(JSON.stringify({ type: 'snapshot', ...scanner.snapshot(), root: ROOT }))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'read_file') {
      try {
        // Defense-in-depth: never serve dotfiles / secrets (.env, .git, …),
        // even to a connection that passed the Origin/Host handshake.
        if (isDotfilePath(msg.id)) {
          ws.send(JSON.stringify({ type: 'file_content', id: msg.id,
            content: '[blocked: dotfiles and secrets are not viewable]', error: true }))
          return
        }
        const full = path.join(ROOT, msg.id)
        if (!isInside(ROOT, full)) return
        const stat = fs.statSync(full)
        if (stat.size > 500_000) {
          ws.send(JSON.stringify({ type: 'file_content', id: msg.id,
            content: '[file too large to preview]', truncated: true }))
          return
        }
        const content = fs.readFileSync(full, 'utf8').slice(0, 100_000)
        ws.send(JSON.stringify({ type: 'file_content', id: msg.id, content }))
      } catch (e) {
        ws.send(JSON.stringify({ type: 'file_content', id: msg.id,
          content: `[error: ${e.message}]`, error: true }))
      }
    }
  })
})

// ─── Start ────────────────────────────────────────────────────
// Bind to loopback only — never expose this dev server to the LAN.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  ┌─ codesynapt ─────────────────────────────────
  │  root: ${ROOT}
  │  open: http://localhost:${PORT}
  └───────────────────────────────────────────────
`)
})

scanner.start()

// A bad file / rejected promise must not kill the dev server.
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e && e.stack || e))
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e && e.stack || e))

process.on('SIGINT', () => {
  console.log('\nshutting down…')
  scanner.stop()
  wss.close()
  server.close(() => process.exit(0))
})
