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
const { app } = require('electron')

const VALID_TYPES = new Set(['theme', 'exporter', 'parser', 'layout', 'panel', 'action'])
const VALID_PERMISSIONS = new Set([
  'read-files', 'read-graph', 'modify-graph',
  'ui-panel', 'context-menu', 'export', 'parse'
])

// Resolve the per-OS plugin folder. We pin it under userData so the
// app handles cross-platform paths for us.
function getPluginDir() {
  return path.join(app.getPath('userData'), 'plugins')
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
//   { manifest, folder, entryPath, entryContent?, error? }
//
// For theme plugins we read the CSS file directly here so the renderer
// can just inject it. For code plugins we read the JS source string and
// pass it to the renderer to execute in its sandbox.
function discoverPlugins() {
  const dir = ensurePluginDir()
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn('[plugin-loader] cannot read plugin dir:', err.message)
    return []
  }

  const results = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const folder = path.join(dir, entry.name)
    const manifestPath = path.join(folder, 'manifest.json')

    let raw
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
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

    results.push({
      folder,
      manifest,
      entryPath,
      entryContent,
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
}
