'use strict'
// ── TS sub-engine (BLOCK) ────────────────────────────────────────────────────
// Self-contained, optional enrichment block. The main AST engine resolves ~80%
// of static calls fast across all languages; this block uses the REAL TypeScript
// type checker (the `typescript` npm dep — already present, no external toolchain)
// to resolve the remaining ~20% that need generic-constraint / field-chain /
// overload resolution — the part name-based AST analysis fundamentally can't do.
//
// Design contract (so editing this never touches the main engine):
//   • Pure: takes a file list + root, returns RAW resolved call records. Knows
//     nothing about SymbolGraph — the merge layer (subengines.cjs) maps records
//     to graph nodes and adds only the edges the main engine MISSED.
//   • Optional: available() is false if `typescript` can't be required; the
//     caller then simply skips this block (main graph unchanged).
//   • Off the hot path: meant to run lazily/in the background — createProgram +
//     full resolution is ~1.5–2s for a few-hundred-file repo.

const path = require('path')
const fs = require('fs')

const EXTS = ['ts', 'tsx', 'mts', 'cts']

let _ts = null
function loadTs() {
  if (_ts !== null) return _ts
  try { _ts = require('typescript') } catch { _ts = false }
  return _ts
}
function available() { return !!loadTs() }

// Resolve every call/new in the TS/TSX files under `rootDir` to its declaration
// via the type checker. Returns records with paths RELATIVE to rootDir (to match
// the scanner's file ids):
//   { callerFile, callLine, calleeName, declName, declFile, declLine }
// declFile is null when the callee resolves outside the project (lib/external) —
// those are dropped by the caller.
function resolve(files, rootDir) {
  const ts = loadTs()
  if (!ts) return []
  const tsFiles = files.filter((f) => EXTS.includes((f.split('.').pop() || '').toLowerCase()) && !f.endsWith('.d.ts'))
  if (!tsFiles.length) return []
  const program = ts.createProgram(tsFiles, {
    allowJs: false, skipLibCheck: true, noEmit: true,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
  })
  const checker = program.getTypeChecker()
  const root = rootDir.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = (abs) => { const p = abs.replace(/\\/g, '/'); return p.startsWith(root + '/') ? p.slice(root.length + 1) : null }
  const out = []
  const inProject = new Set(tsFiles.map((f) => f.replace(/\\/g, '/')))
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!inProject.has(sf.fileName.replace(/\\/g, '/'))) continue
    const callerFile = rel(sf.fileName)
    if (!callerFile) continue
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.CallExpression || node.kind === ts.SyntaxKind.NewExpression) {
        let decl = null, calleeName = null
        try {
          const sig = checker.getResolvedSignature(node)
          decl = sig && sig.declaration
          // callee text (best-effort, for diagnostics/merge keying)
          const ex = node.expression
          if (ex) { const t = ex.getText(sf); calleeName = t.split('.').pop().split('<')[0].replace(/[()]/g, '') }
        } catch {}
        if (decl && decl.getSourceFile && typeof decl.getStart === 'function') {
          const df = decl.getSourceFile()
          const declFileRel = rel(df.fileName)
          if (declFileRel && !df.fileName.endsWith('.d.ts')) {
            const declName = (decl.name && decl.name.getText && decl.name.getText(df))
              || (decl.parent && decl.parent.name && decl.parent.name.getText ? decl.parent.name.getText(df) : null)
              || calleeName
            const line = (n, s) => s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1
            out.push({
              callerFile,
              callLine: line(node, sf),
              calleeName,
              declName,
              declFile: declFileRel,
              declLine: line(decl, df),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out
}

module.exports = { exts: EXTS, available, resolve, name: 'ts' }
