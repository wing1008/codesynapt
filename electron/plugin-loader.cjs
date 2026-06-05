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
  // Privileged host IPC. A plugin that wants to mutate files on disk via the
  // app's write/edit bridge MUST declare this. It is enforced in preload.cjs
  // (the IPC boundary the plugin's renderer realm cannot reach), NOT here.
  'write-files',
])

// Permissions whose grant is *dangerous* — these require an explicit,
// per-plugin trust entry (user approval) before the plugin's code is allowed
// to load and before the permission is honored by the IPC boundary.
const DANGEROUS_PERMISSIONS = new Set(['write-files', 'modify-graph'])

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
// The only real boundary is the main process: we must NOT hand a code
// plugin's executable source to the renderer unless the user has explicitly
// approved that exact code. Approval is pinned to a content hash so that
// silently editing/replacing an approved plugin (e.g. a supply-chain swap on
// disk) revokes trust until re-approved (TOFU: trust on first use, re-prompt
// on change). The record also pins which permissions the user granted, so a
// plugin cannot silently widen its own scope.
//
// The trust store lives in userData ROOT (NOT inside plugins/, so it can't be
// shadowed by a plugin folder of the same name) as a versioned JSON document:
//   { version: 1, plugins: { "<id>": { hash, permissions:[...], approvedAt } } }
function getTrustPath() {
  return path.join(app.getPath('userData'), 'plugins-trust.json')
}

function readTrustStore() {
  try {
    const raw = fs.readFileSync(getTrustPath(), 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && data.plugins && typeof data.plugins === 'object') {
      return data
    }
  } catch { /* missing or corrupt — start fresh */ }
  return { version: 1, plugins: {} }
}

function writeTrustStore(store) {
  try {
    fs.writeFileSync(getTrustPath(), JSON.stringify(store, null, 2), 'utf8')
    return true
  } catch (err) {
    console.warn('[plugin-loader] could not persist trust store:', err.message)
    return false
  }
}

// Identity hash for a plugin = sha256 over the bits that decide what code
// runs and what it may do: the entry source plus the manifest fields that
// govern execution. The plugin id is folded in so a renamed/relocated copy
// still needs its own approval. Author/description churn does not invalidate
// trust; changing the code, type, entry path, or requested permissions does.
function computePluginHash(manifest, entryContent) {
  const h = crypto.createHash('sha256')
  h.update('v1\n')
  h.update(`id:${manifest.id}\n`)
  h.update(`type:${manifest.type}\n`)
  h.update(`main:${manifest.main}\n`)
  h.update(`perms:${[...(manifest.permissions || [])].sort().join(',')}\n`)
  h.update('src:\n')
  h.update(entryContent || '')
  return h.digest('hex')
}

// Is this plugin currently approved for exactly this content+permission set?
// Called from the privileged main process; takes the live manifest + on-disk
// source and compares against the user-approved record.
function isTrusted(manifest, entryContent) {
  const store = readTrustStore()
  const rec = store.plugins[manifest.id]
  if (!rec) return false
  if (rec.hash !== computePluginHash(manifest, entryContent)) return false
  // Granted permissions must be a superset of what the manifest now requests
  // for any dangerous permission; otherwise the plugin grew its scope.
  const granted = new Set(rec.permissions || [])
  for (const p of manifest.permissions || []) {
    if (DANGEROUS_PERMISSIONS.has(p) && !granted.has(p)) return false
  }
  return true
}

// Record approval for a plugin as it currently exists on disk. Called by the
// approval round-trip (renderer → IPC → here) in response to an explicit user
// action (e.g. a "Trust this plugin" button), never from a plugin itself.
// Returns { ok } or { ok:false, reason }.
function approvePlugin(id, opts = {}) {
  const results = discoverPlugins({ includeUntrustedSource: true })
  const rec = results.find((r) => r.manifest && r.manifest.id === id)
  if (!rec) return { ok: false, reason: `plugin "${id}" not found` }
  if (rec.error && rec.entryContent == null) return { ok: false, reason: rec.error }
  const store = readTrustStore()
  store.plugins[id] = {
    hash: computePluginHash(rec.manifest, rec.entryContent),
    permissions: Array.isArray(opts.permissions)
      ? opts.permissions.filter((p) => VALID_PERMISSIONS.has(p))
      : [...(rec.manifest.permissions || [])],
    approvedAt: new Date().toISOString(),
  }
  if (!writeTrustStore(store)) return { ok: false, reason: 'could not persist trust store' }
  return { ok: true }
}

// Revoke trust for a plugin (user disables / uninstalls).
function revokePlugin(id) {
  const store = readTrustStore()
  if (!store.plugins[id]) return { ok: true }
  delete store.plugins[id]
  return { ok: writeTrustStore(store) }
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
// "Trust" prompt) but with entryContent withheld and needsApproval set,
// so the renderer's activatePlugin() skips them.
function discoverPlugins(opts = {}) {
  // includeUntrustedSource is used ONLY by the approval round-trip, which
  // needs to hash the pending code. The normal renderer-facing call never
  // sets it, so untrusted code source is never handed out for execution.
  const includeUntrustedSource = opts.includeUntrustedSource === true
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

    // ── Trust gate ──────────────────────────────────────────────
    // Theme plugins are CSS-only: they never execute JS and cannot hold
    // permissions, so they are low-risk and auto-trusted. Code plugins must
    // have a matching approval record (content hash + granted permissions)
    // before their source is exposed to the renderer for execution. Without
    // one we still report the plugin (so the settings UI can offer an
    // "Approve" button) but we WITHHOLD the source (entryContent: null) and
    // set needsApproval, so the renderer cannot import()/activate unapproved
    // or tampered code (which would otherwise reach window.codesynapt).
    const isTheme = manifest.type === 'theme'
    const hash = computePluginHash(manifest, entryContent)
    const trusted = isTheme || isTrusted(manifest, entryContent)
    const grantedPermissions = trusted
      ? (isTheme ? [] : (trustStore.plugins[manifest.id] || {}).permissions || [])
      : []

    if (!trusted && !includeUntrustedSource) {
      results.push({
        folder,
        manifest,
        entryPath,
        hash,
        entryContent: null,        // never hand untrusted code to the renderer
        trusted: false,
        needsApproval: true,
        grantedPermissions: [],
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
      trusted,
      needsApproval: !trusted,
      grantedPermissions,
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
  getTrustPath,
  computePluginHash,
  isTrusted,
  approvePlugin,
  revokePlugin,
  readTrustStore,
  DANGEROUS_PERMISSIONS,
  VALID_PERMISSIONS,
}
