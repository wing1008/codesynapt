#!/usr/bin/env node
// Competitor monitoring — fetch the latest releases and issues from
// every repo listed in docs/COMPETITOR-WATCH.md and write a digest
// to docs/competitor-log.md. Run weekly.
//
// MAINTAINER-ONLY / OPT-IN. This is the one script in the repo that
// makes outbound network calls (to api.github.com). The shipped product
// is offline by design, so:
//   1. it is excluded from the npm package `files` whitelist (see
//      package.json: "!scripts/competitor-watch.mjs"), so it does NOT
//      travel inside the distributed artifact; and
//   2. it refuses to run unless CS_COMPETITOR_WATCH=1 is set, so it can
//      never fire by accident (e.g. if invoked from a packaged tree).
//
// Uses the public GitHub API (no token required for low-rate usage).
// If GITHUB_TOKEN is set, it's used to lift the 60/h anon rate limit.
//
// Usage:
//   CS_COMPETITOR_WATCH=1 node scripts/competitor-watch.mjs               # default cadence
//   CS_COMPETITOR_WATCH=1 node scripts/competitor-watch.mjs --since 14d   # last 14 days only
//   CS_COMPETITOR_WATCH=1 node scripts/competitor-watch.mjs --repo codegraph

import fs from 'node:fs/promises'
import path from 'node:path'

if (process.env.CS_COMPETITOR_WATCH !== '1') {
  console.error(
    '[competitor-watch] refusing to run: this maintainer script makes outbound\n' +
    'network calls to api.github.com and is opt-in only. Re-run with\n' +
    'CS_COMPETITOR_WATCH=1 to confirm you want the network fetch.'
  )
  process.exit(2)
}

const REPOS = [
  { owner: 'colbymchenry',   name: 'codegraph',     cadence: 'weekly',     why: 'direct competitor' },
  { owner: 'sourcegraph',    name: 'sourcegraph',   cadence: 'biweekly',   why: 'SCIP/LSIF gold standard' },
  { owner: 'sourcegraph',    name: 'scip',          cadence: 'monthly',    why: 'symbol-index format' },
  { owner: 'continuedev',    name: 'continue',      cadence: 'monthly',    why: 'open-source AI agent' },
  { owner: 'Aider-AI',       name: 'aider',         cadence: 'monthly',    why: 'repo-map analogue' },
  { owner: 'modelcontextprotocol', name: 'servers', cadence: 'monthly',    why: 'MCP spec drift' },
  { owner: 'anthropics',     name: 'claude-code',   cadence: 'weekly',     why: 'primary client' },
  { owner: 'tree-sitter',    name: 'tree-sitter',   cadence: 'biweekly',   why: 'parser ABI' },
]

const args = process.argv.slice(2)
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const sinceArg = getArg('--since') || '7d'
const repoFilter = getArg('--repo')

const sinceMs = (() => {
  const m = sinceArg.match(/^(\d+)([dhw])$/)
  if (!m) return 7 * 86400_000
  const n = parseInt(m[1], 10)
  return { d: 86400_000, h: 3600_000, w: 7 * 86400_000 }[m[2]] * n
})()
const sinceDate = new Date(Date.now() - sinceMs)
const sinceIso = sinceDate.toISOString()

const TOKEN = process.env.GITHUB_TOKEN
const HEADERS = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'codesynapt-competitor-watch',
  ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}),
}

async function gh(pathPart) {
  const url = `https://api.github.com${pathPart}`
  const res = await fetch(url, { headers: HEADERS })
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      console.error(`[rate-limit] hit; set GITHUB_TOKEN to lift to 5000/h`)
      return null
    }
  }
  if (!res.ok) {
    console.error(`[gh] ${pathPart} → ${res.status}`)
    return null
  }
  return res.json()
}

async function fetchRepo(repo) {
  const base = `/repos/${repo.owner}/${repo.name}`
  const [releases, issues, commits] = await Promise.all([
    gh(`${base}/releases?per_page=5`),
    gh(`${base}/issues?state=all&sort=updated&since=${sinceIso}&per_page=10`),
    gh(`${base}/commits?since=${sinceIso}&per_page=10`),
  ])
  return {
    repo,
    releases: (releases || []).filter((r) => new Date(r.published_at) > sinceDate),
    issues:   (issues   || []).filter((i) => !i.pull_request),
    prs:      (issues   || []).filter((i) => i.pull_request),
    commits:  (commits  || []).slice(0, 5),
  }
}

function fmtDate(s) { return s ? s.split('T')[0] : '' }

function repoSection(r) {
  const lines = []
  lines.push(`### [${r.repo.owner}/${r.repo.name}](https://github.com/${r.repo.owner}/${r.repo.name}) — _${r.repo.why}_`)
  if (r.releases.length) {
    lines.push(`\n**Releases (${r.releases.length})**`)
    for (const rel of r.releases) {
      lines.push(`- [\`${rel.tag_name}\`](${rel.html_url}) — ${fmtDate(rel.published_at)} · ${(rel.name || '').slice(0, 80)}`)
    }
  }
  if (r.prs.length) {
    lines.push(`\n**PRs (${r.prs.length} updated since ${sinceArg})**`)
    for (const pr of r.prs.slice(0, 5)) {
      lines.push(`- [#${pr.number}](${pr.html_url}) ${pr.state} · ${pr.title.slice(0, 100)}`)
    }
  }
  if (r.issues.length) {
    lines.push(`\n**Issues (${r.issues.length} updated since ${sinceArg})**`)
    for (const iss of r.issues.slice(0, 5)) {
      lines.push(`- [#${iss.number}](${iss.html_url}) ${iss.state} · ${iss.title.slice(0, 100)}`)
    }
  }
  if (!r.releases.length && !r.issues.length && !r.prs.length) {
    lines.push(`\n_no activity since ${sinceArg}_`)
  }
  return lines.join('\n')
}

async function main() {
  const targets = repoFilter
    ? REPOS.filter((r) => r.name === repoFilter)
    : REPOS
  if (!targets.length) {
    console.error(`No repo matches "${repoFilter}". Available: ${REPOS.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
  console.log(`[watch] fetching ${targets.length} repos, since ${sinceIso}`)
  const results = []
  for (const r of targets) {
    process.stdout.write(`  ${r.owner}/${r.name}… `)
    const out = await fetchRepo(r)
    results.push(out)
    console.log(`${out.releases.length}r ${out.prs.length}p ${out.issues.length}i`)
  }
  const today = new Date().toISOString().split('T')[0]
  const md = [
    `## ${today} — last ${sinceArg}`,
    '',
    ...results.map(repoSection).map((s) => s + '\n'),
    '\n---\n',
  ].join('\n')

  // Prepend to docs/competitor-log.md so the newest entry is on top.
  const logPath = path.resolve('docs', 'competitor-log.md')
  let existing = ''
  try { existing = await fs.readFile(logPath, 'utf8') } catch {}
  const header = existing.startsWith('# ') ? '' : '# Competitor activity log\n\n'
  await fs.writeFile(logPath, header + md + existing.replace(/^# Competitor activity log\n\n/, ''))
  console.log(`\nWrote ${logPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
