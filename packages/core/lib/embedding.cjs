// Semantic embeddings via @xenova/transformers (MiniLM-L6-v2, ~25 MB
// quantized ONNX model). Runs entirely locally — no network call at
// query time, no telemetry.
//
// OFFLINE BY DESIGN / OFFLINE BY DEFAULT (hard rule — see CLAUDE.md
// "No network calls", AGENTS.md). By default this module NEVER reaches
// the network. @xenova/transformers ships with `allowRemoteModels:true`
// and a huggingface.co remote host, which means the very first call to
// loadPipeline() would silently fetch the model from
// https://huggingface.co/ at runtime. CodeSynapt fires the embedding
// pass automatically during symbol-mode build (electron/main.cjs), so on
// a machine that has never downloaded the model that default would turn a
// normal `cs`/desktop session into a network call. That is forbidden.
//
// Therefore we force `env.allowRemoteModels = false` unless the user has
// EXPLICITLY opted into a one-time download. With remote models disabled,
// a cold-cache machine resolves the model strictly from disk; if it is
// absent the pipeline fails fast and the caller cleanly falls back to
// keyword-only scoring instead of fetching — no network, no hang.
//
// Opt-in download (either env var is accepted, for backwards compat):
//   CS_EMBED_DOWNLOAD=1     (preferred)
//   CS_EMBEDDING_DOWNLOAD=1 (alias)
// To download the model once (opt-in, build-time / first-run setup):
//   CS_EMBED_DOWNLOAD=1 node -e "require('codesynapt/lib/embedding.cjs').loadPipeline()"
// after which every subsequent run is fully offline from the cache.
//
// The cache lives under env.cacheDir (the package's .cache dir by
// default); override with CS_EMBED_CACHE_DIR to point at a vendored
// model directory shipped with the app.
//
// Used by /symbol/explore to give "auth" ↔ "login" / "signIn" /
// "verifyJWT" the synonym match that keyword-only scoring misses.
//
// All exports are lazy: until the first call, this module doesn't
// even import @xenova/transformers — so the 45 MB dep cost only
// hits processes that actually opt into embedding mode.

'use strict'

// Opt-in switch for the one-time remote model download. Default OFF so
// the offline-by-design guarantee holds for every normal invocation.
const ALLOW_DOWNLOAD =
  process.env.CS_EMBED_DOWNLOAD === '1' ||
  process.env.CS_EMBED_DOWNLOAD === 'true' ||
  process.env.CS_EMBEDDING_DOWNLOAD === '1' ||
  process.env.CS_EMBEDDING_DOWNLOAD === 'true'

let _pipelinePromise = null
let _ready = false
let _failed = false

async function loadPipeline() {
  if (_pipelinePromise) return _pipelinePromise
  if (_failed) return null
  _pipelinePromise = (async () => {
    try {
      const mod = await import('@xenova/transformers')

      // Offline by default: forbid any outbound fetch to huggingface.co.
      // Only an explicit opt-in (CS_EMBED_DOWNLOAD=1 / CS_EMBEDDING_DOWNLOAD=1,
      // captured in ALLOW_DOWNLOAD) re-enables the remote Hugging Face fetch.
      if (mod.env) {
        mod.env.allowRemoteModels = ALLOW_DOWNLOAD
        // Always keep local lookup on so a cached / vendored model is
        // found even when remote is disabled.
        mod.env.allowLocalModels = true
        const cacheOverride = process.env.CS_EMBED_CACHE_DIR
        if (cacheOverride) mod.env.cacheDir = cacheOverride
      }

      const p = await mod.pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { quantized: true }
      )
      _ready = true
      return p
    } catch (e) {
      const offlineHint = ALLOW_DOWNLOAD
        ? ''
        : ' (offline default: model not cached — run once with CS_EMBED_DOWNLOAD=1 to fetch it, then it works offline)'
      console.warn(
        '[embedding] pipeline init failed — falling back to keyword-only:' +
          offlineHint,
        e.message
      )
      _failed = true
      _pipelinePromise = null
      return null
    }
  })()
  return _pipelinePromise
}

// Single text → 384-d normalized vector. Caller should await loadPipeline
// at least once before calling embed in a tight loop.
async function embed(text) {
  const p = await loadPipeline()
  if (!p) return null
  try {
    const out = await p(text, { pooling: 'mean', normalize: true })
    return Array.from(out.data)
  } catch { return null }
}

// Batch of N texts → N vectors. Faster than N single calls thanks
// to ONNX op fusion. CHUNK keeps peak memory bounded.
async function embedBatch(texts) {
  const p = await loadPipeline()
  if (!p) return null
  try {
    const out = await p(texts, { pooling: 'mean', normalize: true })
    const D = out.dims[1]
    const N = out.dims[0]
    const result = []
    for (let i = 0; i < N; i++) {
      result.push(Array.from(out.data.slice(i * D, (i + 1) * D)))
    }
    return result
  } catch (e) {
    console.warn('[embedding] batch failed:', e.message)
    return null
  }
}

// Both vectors come back L2-normalized from the pipeline, so dot
// product is already cosine similarity in [-1, 1].
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

module.exports = {
  loadPipeline,
  embed,
  embedBatch,
  cosineSim,
  isReady: () => _ready,
  isFailed: () => _failed,
}
