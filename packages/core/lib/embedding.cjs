// Semantic embeddings via @xenova/transformers (MiniLM-L6-v2, ~25 MB
// quantized ONNX model). Runs entirely locally — no network call at
// query time, no telemetry. The model itself is fetched once on
// first load and cached under the OS HF cache directory.
//
// Used by /symbol/explore to give "auth" ↔ "login" / "signIn" /
// "verifyJWT" the synonym match that keyword-only scoring misses.
//
// All exports are lazy: until the first call, this module doesn't
// even import @xenova/transformers — so the 45 MB dep cost only
// hits processes that actually opt into embedding mode.

'use strict'

let _pipelinePromise = null
let _ready = false
let _failed = false

async function loadPipeline() {
  if (_pipelinePromise) return _pipelinePromise
  if (_failed) return null
  _pipelinePromise = (async () => {
    try {
      const mod = await import('@xenova/transformers')
      const p = await mod.pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        { quantized: true }
      )
      _ready = true
      return p
    } catch (e) {
      console.warn('[embedding] pipeline init failed — falling back to keyword-only:', e.message)
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
