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

// ─── Security posture (loopback dev server) ───────────────────
// This server binds 127.0.0.1 and is meant to be opened by the local
// user's browser only. Loopback binding alone does NOT protect against a
// malicious web page the developer visits: browser fetch()/WebSocket run
// in the victim's browser and can target http://127.0.0.1 / ws://127.0.0.1
// regardless of the page's own origin. The realistic threats are:
//   1. DNS-rebinding / cross-origin: a malicious public site the user
//      visits makes their browser hit 127.0.0.1:PORT and read served
//      files or open the WS to exfiltrate the scanned source tree.
//   2. Exposure of sensitive dotfiles (.env, .git/…) that may sit inside
//      the served directory.
//   3. Resource exhaustion from streaming arbitrarily large files.
// The controls below address each. There is intentionally NO password
// auth: the only credential a loopback dev tool could check is one the
// same local user already possesses, so the trust boundary is "processes
// running as this user", enforced by the loopback bind + Host allowlist.

// Host-header allowlist — the canonical DNS-rebinding defense. A rebound
// attacker page reaches us over IP but its Host header is the attacker
// domain, so we reject anything that isn't a recognized loopback name.
// (Mirrors control-server.cjs's "forbidden host" 403.)
const hostAllowed = (hostHeader) => {
  if (!hostHeader) return false                  // HTTP/1.1 requires Host; absent ⇒ suspicious
  const host = String(hostHeader).split(':')[0].trim().toLowerCase()
  // strip IPv6 brackets, e.g. [::1]:7777 → ::1
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '::ffff:127.0.0.1'
}

// Origin allowlist (browsers send Origin on WS handshakes and CORS/fetch).
// Same-origin requests from our own page carry our loopback Origin; a
// rebound or third-party page carries its own. Absent Origin (curl, the
// CLI, EventSource-less direct nav) is allowed — those aren't attacker JS.
// file:// pages and some sandboxes send the literal "null" Origin; allow it.
const originAllowed = (originHeader) => {
  if (!originHeader) return true
  if (originHeader === 'null') return true
  try {
    const u = new URL(originHeader)
    if (u.protocol === 'file:') return true
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1'
  } catch { return false }
}

// Dotfile policy — deny any path whose components start with '.', which
// covers .env, .env.local, .git/*, .htpasswd, .npmrc, .ssh, .aws, etc.
// Applies to HTTP serving and the WS read_file channel alike, so a
// cross-origin or compromised client cannot exfiltrate secrets within ROOT.
const hasDotSegment = (rel) =>
  String(rel).split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '' && seg !== '.' && seg !== '..')

// Cap on bytes streamed for any single static HTTP asset. The bundled UI
// assets are well under this; an attacker-planted or symlinked huge file
// must not be streamed unbounded.
const MAX_STATIC_BYTES = 25 * 1024 * 1024   // 25 MB

const server = http.createServer((req, res) => {
  // (1) Host-header defense (anti DNS-rebinding) — applies to every request.
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden host'); return
  }
  // (1b) Reject cross-origin browser requests outright.
  if (!originAllowed(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden origin'); return
  }
  // (2) Method gate — a static server only answers GET/HEAD.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' })
    res.end('method not allowed'); return
  }

  let rel = req.url.split('?')[0]
  try { rel = decodeURIComponent(rel) } catch {}   // normalize %2e%2e etc.
  if (rel === '/') rel = '/index.html'

  // (3) Dotfile policy — never serve .env / .git/* / dotfiles.
  if (hasDotSegment(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return
  }

  const filePath = path.join(PUBLIC, rel)
  if (!isInside(PUBLIC, filePath)) {
    res.writeHead(403); res.end(); return
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return }
    // (4) Size gate.
    if (stat.size > MAX_STATIC_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('file too large'); return
    }
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Defense-in-depth: forbid embedding by a foreign page and MIME sniffing.
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    }
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
    res.writeHead(200, headers)
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => { try { res.destroy() } catch {} })
    stream.pipe(res)
  })
})

// ─── WebSocket ────────────────────────────────────────────────
// verifyClient runs during the HTTP Upgrade handshake. The WS carries the
// full scanned source tree (snapshots) and answers read_file, so an attacker
// who can open it can exfiltrate the project. Reject any connection whose
// Host header isn't loopback (DNS-rebinding) or whose Origin is cross-origin
// (a malicious page in the victim's browser), applying the same Host + Origin
// allowlist as HTTP so a rebound/cross-origin handshake is refused at upgrade.
// Same-origin localhost UI use sends Origin: http://localhost:<port> (or
// 127.0.0.1) and is allowed.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, done) => {
    if (!hostAllowed(req.headers.host)) return done(false, 403, 'forbidden host')
    if (!originAllowed(req.headers.origin)) return done(false, 403, 'forbidden origin')
    done(true)
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
        if (typeof msg.id !== 'string') return
        // Defense-in-depth: same dotfile policy as HTTP — never serve
        // dotfiles / secrets (.env, .git/*, …), even to a connection that
        // passed the Origin/Host handshake.
        if (hasDotSegment(msg.id)) {
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
