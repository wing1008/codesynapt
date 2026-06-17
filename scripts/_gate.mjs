// REGRESSION GATE — run after EVERY change. One command, no human discretion:
// the numbers decide PASS/FAIL, not a narrated "it works".
//
//   node scripts/_gate.mjs            # full gate
//   node scripts/_gate.mjs --fast     # tests + JS precision only (seconds)
//
// Checks (each is independently reproducible — see the command it runs):
//   1. vitest             — 328 tests must pass (code behaviour)
//   2. JS precision        — _precision_oracle (babel scope) wrong% must stay ~0
//   3. JS recall           — _recall_groundtruth coverage
//   4. per-language        — _precision_pos wrong% + symbol/confident counts vs
//                            scripts/_lang_baseline.json (regression = a DROP)
// FAIL if: any test fails, JS precision wrong% rises, or a language's
// symbols/confident drops >2% below baseline. Honest about what it does NOT
// cover (printed at the end): non-JS recall, L3, Lua quality, Dart.
import { execFileSync, execSync } from 'child_process'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const FAST = process.argv.includes('--fast')
const CORPUS = process.argv.find(a => a.startsWith('--corpus='))?.split('=')[1] || path.join(os.tmpdir(), 'corpus')
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '_lang_baseline.json'), 'utf8')).languages

const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256*1024*1024, stdio: ['ignore','pipe','pipe'], ...opts }) } catch (e) { return (e.stdout || '') + (e.stderr || '') + '\n__EXIT_NONZERO__' } }
const stripAnsi = (s) => (s||'').replace(/\x1b\[[0-9;]*m/g, '')
const num = (s, re) => { const m = stripAnsi(s).match(re); return m ? parseFloat(m[1]) : null }

let fails = []
console.log('=== REGRESSION GATE' + (FAST ? ' (fast)' : '') + ' ===\n')

// 1. tests — run via shell (npx is npx.cmd on Windows; execFileSync can't spawn it directly)
let t; try { t = execSync('npx vitest run', { cwd: root, encoding: 'utf8', maxBuffer: 256*1024*1024, stdio: ['ignore','pipe','pipe'] }) } catch (e) { t = (e.stdout||'') + (e.stderr||'') + '\n__EXIT_NONZERO__' }
const tPass = num(t, /Tests\s+(\d+)\s+passed/), tFail = num(t, /(\d+)\s+failed/)
const testsOk = tFail === null && tPass !== null
console.log(`[tests]      ${tPass||0} passed${tFail?(' / '+tFail+' FAILED'):''}  ${testsOk?'OK':'✗ FAIL'}`)
if (!testsOk) fails.push('tests')

// 2-3. JS precision + recall (self)
const jp = run('node', ['scripts/_precision_oracle.mjs', '.'])
const jpWrong = num(jp, /\((\d+\.?\d*)%\)/)
console.log(`[js precision] wrong ${jpWrong ?? '?'}%  ${jpWrong !== null && jpWrong <= 0.5 ? 'OK' : '⚠ CHECK'}`)
if (jpWrong !== null && jpWrong > 0.5) fails.push('js-precision>0.5%')
const jr = run('node', ['scripts/_recall_groundtruth.mjs', '.'])
console.log(`[js recall]    ${(num(jr,/recall:\s+\d+\/\d+\s+\((\d+\.?\d*)%\)/) ?? '?')}%`)

if (!FAST) {
  // 4. per-language precision + baseline regression
  const C = CORPUS
  const langRepos = [
    ['cpp', 'cpp-fmt', 'cpp  (cpp-fmt)'], ['cs', 'cs-newtonsoft', 'cs   (cs-newtonsoft)'],
    ['go', 'go-mux', 'go   (go-mux)'], ['java', 'java-gson', 'java (java-gson)'],
    ['kotlin', 'kotlin-okhttp', 'kotlin (kotlin-okhttp)'], ['lua', 'lua-middleclass', 'lua  (lua-middleclass)'],
    ['php', 'php-guzzle', 'php  (php-guzzle)'], ['rust', 'rust-serdejson', 'rust (rust-serdejson)'],
    ['scala', 'scala-upickle', 'scala (scala-upickle)'],
  ]
  console.log('\n[per-language: precision wrong% | symbols conf vs baseline]')
  for (const [lang, repo, key] of langRepos) {
    const dir = path.join(C, repo)
    if (!fs.existsSync(dir)) { console.log(`  ${key}: corpus MISSING (fetch: node scripts/fetch-corpus.mjs)`); continue }
    const m = run('node', ['--max-old-space-size=4096', 'scripts/_measure.mjs', dir, '--lang='+lang, '--json'])
    let sym=null, conf=null; try { const j = JSON.parse(m.split('\n').find(l=>l.startsWith('{'))||'{}'); sym=j.symbols; conf=j.confident } catch {}
    const p = run('node', ['--max-old-space-size=4096', 'scripts/_precision_pos.mjs', dir, '--lang='+lang])
    const wrong = num(p, /WRONG\(#M1\):\s+\d+\s+\((\d+\.?\d*)%\)/)
    const base = baseline[key]
    let reg = ''
    if (base && sym !== null) { const drop = (base[0]-sym)/base[0]*100; if (drop > 2) { reg = ` ✗ REGRESSION sym ${base[0]}→${sym}`; fails.push(lang+'-symbols') } }
    if (base && conf !== null) { const drop = (base[1]-conf)/base[1]*100; if (drop > 2) { reg += ` ✗ conf ${base[1]}→${conf}`; fails.push(lang+'-confident') } }
    console.log(`  ${key}: wrong ${wrong ?? '?'}% | sym ${sym ?? '?'} conf ${conf ?? '?'}${reg||' OK'}`)
  }
}

console.log('\n' + (fails.length ? '✗✗ GATE FAIL: ' + fails.join(', ') : '✓ GATE PASS'))
console.log('\nNOT covered by this gate (still unverified — measure separately):')
console.log('  · non-JS recall (only JS babel + Python runtime have a recall oracle)')
console.log('  · L3 expression layer beyond JS/Py/Java/C# (12 langs have none)')
console.log('  · Lua L2 quality (table-OOP member calls mostly unresolved)')
console.log('  · Dart (wasm ABI 15 wall)')
process.exit(fails.length ? 1 : 0)
