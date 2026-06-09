// Standalone test for the registry/lease module. Run: `node packages/core/lib/registry.test.js`
// Uses a throwaway CS_HOME so it never touches the real ~/.codesynapt.
const os = require('os'), path = require('path'), fs = require('fs')
process.env.CS_HOME = path.join(os.tmpdir(), 'cs_reg_test_' + process.pid + '_' + Date.now())
const R = require('./registry.cjs')

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg) } }

// 1. canonical projectHash is invariant to case / separator / trailing slash.
//    (Use forward-slash literals — backslash literals get mangled by shells.)
const ha = R.projectHash('C:/Foo/Bar')
const hb = R.projectHash('c:/foo/bar/')
const hc = R.projectHash('C:/Foo/Bar/')
if (process.platform === 'win32') {
  ok(ha === hb && hb === hc, `win32 canonical hash invariant (${ha} ${hb} ${hc})`)
} else {
  ok(R.projectHash('/tmp/x/') === R.projectHash('/tmp/x'), 'posix trailing-slash invariant')
}

// 2. touch + readLive
R.touch('session', 's1', { projectRoot: '/p', port: 1, pid: 99, label: 'A' })
let live = R.readLive('session', { ttlMs: 60000 })
ok(live.length === 1 && live[0].id === 's1' && live[0].label === 'A', 'session lease readLive')

// 3. TTL expiry (backdate lastSeen directly)
const f = R.fileFor('session', 's1')
const e = JSON.parse(fs.readFileSync(f, 'utf8')); e.lastSeen = Date.now() - 99999
fs.writeFileSync(f, JSON.stringify(e))
ok(R.readLive('session', { ttlMs: 5000 }).length === 0, 'expired lease excluded by TTL')
ok(R.readLive('session', { ttlMs: Infinity }).length === 1, 'expired still present without TTL')

// 4. cleanStale removes it
ok(R.cleanStale('session', 5000) === 1 && R.readLive('session', { ttlMs: Infinity }).length === 0, 'cleanStale removes expired')

// 5. torn / non-JSON file is skipped, never throws
fs.writeFileSync(R.fileFor('session', 'garbage'), '{not json')
ok(R.readLive('session', { ttlMs: Infinity }).length === 0, 'torn file skipped without throwing')

// 6. daemon spawn-lock: first wins, second sees the live owner, port is carried
const ph = 'deadbeef'
ok(R.acquireDaemonLock(ph, { pid: 1, epoch: 'e1' }, 60000).won === true, 'first acquireDaemonLock wins')
R.setDaemonPort(ph, 7800)
const b = R.acquireDaemonLock(ph, { pid: 2, epoch: 'e2' }, 60000)
ok(b.won === false && b.existing && b.existing.port === 7800, 'second sees live daemon (won=false, port carried)')
ok(R.readDaemon(ph, 60000) && R.readDaemon(ph, 60000).port === 7800, 'readDaemon returns bound port')

// 7. stale daemon lock is broken and re-won
const df = R.fileFor('daemon', ph)
const de = JSON.parse(fs.readFileSync(df, 'utf8')); de.lastSeen = Date.now() - 99999
fs.writeFileSync(df, JSON.stringify(de))
ok(R.acquireDaemonLock(ph, { pid: 3, epoch: 'e3' }, 5000).won === true, 'stale daemon lock broken and re-won')

// cleanup temp home
try {
  for (const t of Object.values(R.DIRS)) {
    const dd = path.join(R.ROOT, t)
    for (const n of (fs.existsSync(dd) ? fs.readdirSync(dd) : [])) fs.unlinkSync(path.join(dd, n))
    if (fs.existsSync(dd)) fs.rmdirSync(dd)
  }
  fs.rmdirSync(R.ROOT)
} catch { /* best effort */ }

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} ok, ${fail} fail)  platform=${process.platform}`)
process.exit(fail ? 1 : 0)
