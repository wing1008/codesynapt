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
filegraph3d — Real-time 3D file/code dependency visualizer

Usage:
  filegraph3d <directory> [--port <n>]

Examples:
  filegraph3d .
  filegraph3d ~/projects/myapp --port 8080
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

const server = http.createServer((req, res) => {
  let rel = req.url.split('?')[0]
  if (rel === '/') rel = '/index.html'
  const filePath = path.join(PUBLIC, rel)
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end(); return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' })
    res.end(data)
  })
})

// ─── WebSocket ────────────────────────────────────────────────
const wss = new WebSocketServer({ server })
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
        const full = path.join(ROOT, msg.id)
        if (!full.startsWith(ROOT)) return
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
server.listen(PORT, () => {
  console.log(`
  ┌─ filegraph3d ─────────────────────────────────
  │  root: ${ROOT}
  │  open: http://localhost:${PORT}
  └───────────────────────────────────────────────
`)
})

scanner.start()

process.on('SIGINT', () => {
  console.log('\nshutting down…')
  scanner.stop()
  wss.close()
  server.close(() => process.exit(0))
})
