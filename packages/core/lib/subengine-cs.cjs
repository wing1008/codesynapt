'use strict'
// ── C# sub-engine (BLOCK) ────────────────────────────────────────────────────
// Resolves C# calls to their declarations with full type info via Roslyn
// (Microsoft.CodeAnalysis) — bundled inside the .NET SDK, so this is offline but
// TOOLCHAIN-GATED (needs a .NET SDK; available() false otherwise -> AST fallback).
//
// A tiny C# helper (subengine-cs/Sub.cs) does the parse + semantic resolution
// and emits one JSON record per line. It's built once with `dotnet build` (a
// generated .csproj that references the SDK's Roslyn DLLs directly — no NuGet,
// so no network) into a temp cache. Pure; the merge layer maps records to nodes.

const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SRC = path.join(__dirname, 'subengine-cs', 'Sub.cs')

let _bincore = null
function bincore() {
  if (_bincore !== null) return _bincore
  _bincore = null
  try {
    const out = cp.execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+\[(.+)\]\s*$/)
      if (!m) continue
      const bc = path.join(m[2], m[1], 'Roslyn', 'bincore')
      if (fs.existsSync(path.join(bc, 'Microsoft.CodeAnalysis.CSharp.dll'))) _bincore = bc // last (highest) wins
    }
  } catch { _bincore = null }
  return _bincore
}

let _avail = null
function available() { if (_avail !== null) return _avail; _avail = !!bincore(); return _avail }

let _dll = null
function ensureBuilt() {
  if (_dll) return _dll
  const bc = bincore(); if (!bc) return null
  const dir = path.join(os.tmpdir(), 'cs-subengine-cs')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(SRC, path.join(dir, 'Sub.cs'))
  const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
    + '<TargetFramework>net9.0</TargetFramework><Nullable>disable</Nullable><AssemblyName>Sub</AssemblyName>'
    + '<EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup>'
    + '<Compile Include="Sub.cs" />'
    + '<Reference Include="Microsoft.CodeAnalysis"><HintPath>' + path.join(bc, 'Microsoft.CodeAnalysis.dll') + '</HintPath></Reference>'
    + '<Reference Include="Microsoft.CodeAnalysis.CSharp"><HintPath>' + path.join(bc, 'Microsoft.CodeAnalysis.CSharp.dll') + '</HintPath></Reference>'
    + '</ItemGroup></Project>'
  fs.writeFileSync(path.join(dir, 'Sub.csproj'), csproj)
  const dll = path.join(dir, 'bin', 'Release', 'net9.0', 'Sub.dll')
  const stale = !fs.existsSync(dll) || fs.statSync(SRC).mtimeMs > fs.statSync(dll).mtimeMs
  if (stale) cp.execFileSync('dotnet', ['build', '-c', 'Release', '--nologo', '-v', 'q'], { cwd: dir, stdio: 'ignore' })
  _dll = dll
  return dll
}

function resolve(files, rootDir) {
  if (!available()) return []
  if (!files.some((f) => f.toLowerCase().endsWith('.cs'))) return []
  try {
    const dll = ensureBuilt(); if (!dll) return []
    const out = cp.execFileSync('dotnet', [dll, rootDir], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const recs = []
    for (const line of out.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r.declName) recs.push(r) } catch { /* skip */ } }
    return recs
  } catch { return [] }
}

module.exports = { exts: ['cs'], available, resolve, name: 'cs' }
