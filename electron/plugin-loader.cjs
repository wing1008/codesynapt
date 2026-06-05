// ═══════════════════════════════════════════════════════════
//  Plugin loader — main process side
//
//  Responsibilities:
//   - Discover plugin folders under the user's plugin directory
//   - Read and validate each manifest.json
//   - Hand the list back to the renderer; the renderer activates
//     code plugins inside its own context (sandboxed by Electron's
//     contextIsolation) and loads theme CSS directly.
//
//  The plugin directory is one of:
//    macOS:   ~/Library/Application Support/codesynapt/plugins
//    Windows: %APPDATA%\codesynapt\plugins
//    Linux:   ~/.config/codesynapt/plugins
//
//  Each plugin is its own folder containing manifest.json plus
//  the entry file (theme.css or main.js).
// ═══════════════════════════════════════════════════════════
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')

const VALID_TYPES = new Set(['theme', 'exporter', 'parser', 'layout', 'panel', 'action'])
const VALID_PERMISSIONS = new Set([
  'read-files', 'read-graph', 'modify-graph',
  'ui-panel', 'context-menu', 'export', 'parse',
  // 'command' and 'layout' gate ui.registerCommand / layouts.register in
  // plugin-host.js. They live here so a manifest can actually *declare*
  // the permission the renderer requires (keep this whitelist in sync
  // with the requirePerm() calls in public/plugin-host.js).
  'command', 'layout',
])

// Resolve the per-OS plugin folder. We pin it under userData so the
// app handles cross-platform paths for us.
function getPluginDir() {
  return path.join(app.getPath('userData'), 'plugins')
}

// ─── Trust / approval gate ──────────────────────────────────────
//
// A userData plugin is *untrusted code dropped into a folder*. Once the
// renderer import()s its source it runs in the same JS realm as the
// privileged window.codesynapt bridge and can call any IPC directly,
// bypassing the per-plugin permission model entirely (the renderer-side
// `ctx` gate only constrains well-behaved plugins).
//
// The only real boundary is the main process: we must NOT hand a
// plugin's executable source to the renderer unless the user has
// explicitly approved that exact code. We pin approval to a content
// hash so that silently editing/replacing an approved plugin (e.g. a
// supply-chain swap on disk) revokes trust until re-approved.
//
// The trust store lives in userData root (NOT inside plugins/, so it
// can't be shadowed by a plugin folder) as a simple JSON map:
//   { "<pluginId>": "<sha256-of-manifest+entry>" }
function getTrustStorePath() {
  return path.join(app.getPath('userData'), 'plugins-trust.json')
}

function readTrustStore() {
  try {
    const raw = fs.readFileSync(getTrustStorePath(), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function writeTrustStore(store) {
  try {
    fs.writeFileSync(getTrustStorePath(), JSON.stringify(store, null, 2), 'utf8')
    return true
  } catch (err) {
    console.warn('[plugin-loader] could not persist trust store:', err.message)
    return false
  }
}

// Stable fingerprint of the exact bytes the renderer would execute,
// bound to the plugin id so a renamed/relocated copy still needs its
// own approval.
function fingerprint(id, manifestRaw, entryContent) {
  const h = crypto.createHash('sha256')
  h.update(String(id))
  h.update('\0')
  h.update(manifestRaw || '')
  h.update('\0')
  h.update(entryContent || '')
  return h.digest('hex')
}

// Mark a plugin (by id, at its current on-disk hash) as approved.
// Returns true on success. Called from the privileged main process in
// response to an explicit user action (e.g. a "Trust this plugin"
// button), never from a plugin.
function approvePlugin(id, hash) {
  if (!id || !hash) return false
  const store = readTrustStore()
  store[id] = hash
  return writeTrustStore(store)
}

// Withdraw trust for a plugin id.
function revokePlugin(id) {
  if (!id) return false
  const store = readTrustStore()
  if (!(id in store)) return true
  delete store[id]
  return writeTrustStore(store)
}

function isTrusted(store, id, hash) {
  return Boolean(id) && store[id] === hash
}

// Make sure the directory exists so users can drop plugins into it
// without having to mkdir manually.
function ensurePluginDir() {
  const dir = getPluginDir()
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn('[plugin-loader] could not create plugin dir:', err.message)
  }
  return dir
}

// Validate a parsed manifest against the schema. Returns either
// { ok: true, manifest } or { ok: false, reason: string }.
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' }
  const required = ['id', 'name', 'version', 'type', 'main']
  for (const k of required) {
    if (!raw[k] || typeof raw[k] !== 'string') {
      return { ok: false, reason: `missing or invalid "${k}"` }
    }
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(raw.id)) {
    return { ok: false, reason: `invalid id "${raw.id}" (use alphanumeric + dash/underscore)` }
  }
  if (!VALID_TYPES.has(raw.type)) {
    return { ok: false, reason: `unknown type "${raw.type}"` }
  }
  // Permissions are optional; if present must be an array of known strings
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) {
      return { ok: false, reason: 'permissions must be an array' }
    }
    for (const p of raw.permissions) {
      if (!VALID_PERMISSIONS.has(p)) {
        return { ok: false, reason: `unknown permission "${p}"` }
      }
    }
  }
  // Provide defaults for optional fields so the renderer doesn't
  // have to null-check them
  return {
    ok: true,
    manifest: {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      author: raw.author || 'unknown',
      description: raw.description || '',
      type: raw.type,
      main: raw.main,
      minAppVersion: raw.minAppVersion || '0.0.0',
      license: raw.license || 'unknown',
      homepage: raw.homepage || null,
      permissions: raw.permissions || [],
    }
  }
}

// Discover all plugins. Returns an array of:
//   { manifest, folder, entryPath, entryContent?, hash?, trusted, error? }
//
// For theme plugins we read the CSS file directly here so the renderer
// can just inject it. For code plugins we read the JS source string and
// pass it to the renderer to execute in its sandbox.
//
// Trust gate: a plugin is only handed its executable `entryContent` once
// the user has approved that exact code (see the trust store above).
// Un-approved plugins are still *listed* (so the settings UI can show a
// "Trust" prompt) but with entryContent withheld and an explanatory
// error, so the renderer's activatePlugin() skips them.
function discoverPlugins() {
  const dir = ensurePluginDir()
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn('[plugin-loader] cannot read plugin dir:', err.message)
    return []
  }

  const trustStore = readTrustStore()
  const results = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const folder = path.join(dir, entry.name)
    const manifestPath = path.join(folder, 'manifest.json')

    let raw
    let rawText
    try {
      rawText = fs.readFileSync(manifestPath, 'utf8')
      raw = JSON.parse(rawText)
    } catch (err) {
      results.push({
        folder, error: `manifest unreadable: ${err.message}`,
        manifest: { id: entry.name, name: entry.name, type: 'unknown' }
      })
      continue
    }

    const validation = validateManifest(raw)
    if (!validation.ok) {
      results.push({
        folder, error: `invalid manifest: ${validation.reason}`,
        manifest: { id: raw.id || entry.name, name: raw.name || entry.name, type: raw.type || 'unknown' }
      })
      continue
    }

    const { manifest } = validation
    // Security: the entry file must live inside the plugin folder.
    // Reject anything escaping with .. or absolute paths.
    const entryPath = path.resolve(folder, manifest.main)
    const rel = path.relative(folder, entryPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      results.push({
        folder, manifest,
        error: `entry path escapes plugin folder: ${manifest.main}`
      })
      continue
    }
    if (!fs.existsSync(entryPath)) {
      results.push({
        folder, manifest,
        error: `entry file not found: ${manifest.main}`
      })
      continue
    }

    let entryContent = null
    try {
      entryContent = fs.readFileSync(entryPath, 'utf8')
    } catch (err) {
      results.push({
        folder, manifest,
        error: `cannot read entry: ${err.message}`
      })
      continue
    }

    // Trust gate: fingerprint the exact bytes the renderer would run and
    // compare against the user-approved hash. Withhold entryContent
    // until approved so the renderer cannot import()/activate untrusted
    // code (which would otherwise reach window.codesynapt directly).
    const hash = fingerprint(manifest.id, rawText, entryContent)
    const trusted = isTrusted(trustStore, manifest.id, hash)
    if (!trusted) {
      results.push({
        folder,
        manifest,
        entryPath,
        hash,
        trusted: false,
        error: 'plugin not approved — review and trust it to enable',
      })
      continue
    }

    results.push({
      folder,
      manifest,
      entryPath,
      entryContent,
      hash,
      trusted: true,
      error: null,
    })
  }
  return results
}

module.exports = {
  getPluginDir,
  ensurePluginDir,
  discoverPlugins,
  validateManifest,
  // Trust / approval gate (driven from the privileged main process only)
  getTrustStorePath,
  readTrustStore,
  approvePlugin,
  revokePlugin,
  fingerprint,
}
