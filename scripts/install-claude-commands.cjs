#!/usr/bin/env node
// Best-effort installer for the /codesynapt slash commands.
//
// On `npm install codesynapt`, copy the FORCE / AUTO slash commands into the
// user's Claude Code config (~/.claude/commands) so `/codesynapt` works without
// manual file copying. This is INTENTIONALLY non-fatal and minimally invasive:
//
//   • Skips silently if Claude Code isn't set up (~/.claude absent) — we never
//     create ~/.claude ourselves.
//   • Skips in CI (process.env.CI) and when CS_NO_CLAUDE_COMMANDS is set.
//   • Backs up a differing existing copy to <name>.bak before overwriting.
//   • Always exits 0 — a failure here must never break `npm install`.
//
// Run standalone any time with: node scripts/install-claude-commands.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')

function main() {
  if (process.env.CS_NO_CLAUDE_COMMANDS) return
  if (process.env.CI) return
  const home = os.homedir && os.homedir()
  if (!home) return
  const claudeDir = path.join(home, '.claude')
  // Only act if Claude Code is actually installed — don't create ~/.claude.
  if (!fs.existsSync(claudeDir)) return
  const cmdDir = path.join(claudeDir, 'commands')
  try { fs.mkdirSync(cmdDir, { recursive: true }) } catch { return }
  const srcDir = path.join(__dirname, '..', 'claude-commands')
  let copied = 0
  for (const name of ['codesynapt.md', 'codesynapt-auto.md']) {
    const src = path.join(srcDir, name)
    const dst = path.join(cmdDir, name)
    if (!fs.existsSync(src)) continue
    try {
      const srcContent = fs.readFileSync(src, 'utf8')
      if (fs.existsSync(dst)) {
        const dstContent = fs.readFileSync(dst, 'utf8')
        const norm = (s) => s.replace(/\r\n/g, '\n')
        if (norm(dstContent) === norm(srcContent)) continue // already up to date (ignore CRLF)
        try { fs.copyFileSync(dst, dst + '.bak') } catch {} // preserve user/older copy
      }
      fs.writeFileSync(dst, srcContent)
      copied++
    } catch {}
  }
  if (copied) {
    console.log(`[codesynapt] installed ${copied} slash command(s) → ${cmdDir} (use /codesynapt or /codesynapt-auto). Set CS_NO_CLAUDE_COMMANDS=1 to skip.`)
  }
}

try { main() } catch {}
process.exit(0)
