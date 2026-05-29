// ═══════════════════════════════════════════════════════════════
//  backend.js — physics backend dispatcher
//
//  Three modes:
//    'gpu'  → WebGPU compute (when available, not contended)
//    'cpu'  → CPU stepCPU() in app.js (always available, scales OK)
//    'auto' → Start GPU if available; if GPU becomes saturated
//             (sustained >60% of frame budget), transparently
//             switch to CPU. If GPU recovers later, switch back.
//
//  Public surface:
//    init({ onStatusChange })        — async, sets up GPU if possible
//    setMode('gpu' | 'cpu' | 'auto') — user choice from settings UI
//    getStatus()                     — { mode, active, gpuAvailable,
//                                         gpuTimeMs, reason }
//    runStep(dt, stepCPU, stepGPU)   — dispatched per frame from
//                                       app.js render loop
//
//  Persists user preference in localStorage so the toggle survives
//  app restarts.
//
//  GPU contention detection:
//    Each GPU step ends with await device.queue.onSubmittedWorkDone(),
//    timed via performance.now(). If the average of the last
//    SAMPLE_WINDOW frames exceeds CONTENTION_MS, we declare the GPU
//    contended (likely a heavy app like Wan 2.2 inference is using
//    it) and fall back to CPU. We keep probing every PROBE_INTERVAL_MS
//    by running one GPU step and checking its timing.
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY = 'codesynapt:backend_mode'
const SAMPLE_WINDOW = 30          // frames to average for contention
const CONTENTION_MS = 10          // GPU step >10ms avg = contended
const RECOVERY_MS = 4             // probe shows <4ms = healthy again
const PROBE_INTERVAL_MS = 3000    // re-test GPU every 3s in fallback

const state = {
  mode: 'auto',                   // user preference: 'auto'|'gpu'|'cpu'
  active: 'cpu',                  // what's actually running this frame
  gpuAvailable: false,            // navigator.gpu and adapter exist
  gpuInitError: null,             // string describing init failure
  device: null,                   // GPUDevice, populated on init
  adapter: null,                  // GPUAdapter
  gpuTimeMs: 0,                   // smoothed GPU step time
  reason: 'not initialized',      // human-readable status
  sampleBuffer: new Float32Array(SAMPLE_WINDOW),
  sampleIdx: 0,
  sampleCount: 0,
  lastProbeAt: 0,
  listeners: [],
}

function loadPreference() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'auto' || v === 'gpu' || v === 'cpu') state.mode = v
  } catch { /* localStorage may be blocked */ }
}
function savePreference() {
  try { localStorage.setItem(STORAGE_KEY, state.mode) } catch { /* ignore */ }
}

function emit() {
  const snapshot = getStatus()
  for (const fn of state.listeners) fn(snapshot)
}

function recordSample(ms) {
  state.sampleBuffer[state.sampleIdx] = ms
  state.sampleIdx = (state.sampleIdx + 1) % SAMPLE_WINDOW
  if (state.sampleCount < SAMPLE_WINDOW) state.sampleCount++
  // Exponential moving average for display
  state.gpuTimeMs = state.gpuTimeMs * 0.9 + ms * 0.1
}

function averageGpuTime() {
  if (state.sampleCount === 0) return 0
  let sum = 0
  for (let i = 0; i < state.sampleCount; i++) sum += state.sampleBuffer[i]
  return sum / state.sampleCount
}

function clearSamples() {
  state.sampleCount = 0
  state.sampleIdx = 0
  state.gpuTimeMs = 0
}

// ─── Public API ─────────────────────────────────────────────────

export async function init({ onStatusChange } = {}) {
  if (onStatusChange) state.listeners.push(onStatusChange)
  loadPreference()

  if (!('gpu' in navigator)) {
    state.gpuInitError = 'WebGPU not available in this browser/build'
    state.reason = state.gpuInitError
    state.active = 'cpu'
    emit()
    return
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    })
    if (!adapter) {
      state.gpuInitError = 'No WebGPU adapter found'
      state.reason = state.gpuInitError
      state.active = 'cpu'
      emit()
      return
    }
    const device = await adapter.requestDevice({
      // Ask for the limits we need for big graphs
      requiredLimits: {
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize,
          256 * 1024 * 1024,
        ),
      },
    })
    device.lost.then((info) => {
      console.warn('WebGPU device lost:', info.message)
      state.gpuAvailable = false
      state.device = null
      state.active = 'cpu'
      state.reason = `GPU device lost: ${info.message}`
      emit()
    })
    state.adapter = adapter
    state.device = device
    state.gpuAvailable = true
    state.reason = 'GPU ready'

    // Initial active backend based on preference
    if (state.mode === 'cpu') {
      state.active = 'cpu'
      state.reason = 'CPU mode selected by user'
    } else {
      state.active = 'gpu'
      state.reason = 'GPU active'
    }
  } catch (err) {
    state.gpuInitError = err.message || String(err)
    state.reason = `GPU init failed: ${state.gpuInitError}`
    state.active = 'cpu'
  }
  emit()
}

export function setMode(mode) {
  if (mode !== 'auto' && mode !== 'gpu' && mode !== 'cpu') return
  state.mode = mode
  savePreference()
  clearSamples()
  if (mode === 'cpu') {
    state.active = 'cpu'
    state.reason = 'CPU mode selected'
  } else if (mode === 'gpu') {
    if (state.gpuAvailable) {
      state.active = 'gpu'
      state.reason = 'GPU mode forced'
    } else {
      state.active = 'cpu'
      state.reason = state.gpuInitError || 'GPU not available'
    }
  } else {
    // auto
    state.active = state.gpuAvailable ? 'gpu' : 'cpu'
    state.reason = state.gpuAvailable
      ? 'auto: GPU active'
      : (state.gpuInitError || 'auto: GPU unavailable, using CPU')
  }
  emit()
}

export function getStatus() {
  return {
    mode: state.mode,
    active: state.active,
    gpuAvailable: state.gpuAvailable,
    gpuTimeMs: state.gpuTimeMs,
    reason: state.reason,
    gpuInitError: state.gpuInitError,
  }
}

export function subscribe(fn) {
  state.listeners.push(fn)
  fn(getStatus())
  return () => {
    const i = state.listeners.indexOf(fn)
    if (i >= 0) state.listeners.splice(i, 1)
  }
}

// ─── Per-frame dispatch ─────────────────────────────────────────
//
//  app.js calls runStep(dt, stepCPU, stepGPU) each frame. We
//  decide which backend to use based on state.active, then measure
//  GPU time if applicable, and consider switching modes for 'auto'.
//
//  stepGPU is OPTIONAL — until v0.6 implements actual compute
//  shaders, it can be null. In that case any 'gpu' request silently
//  runs CPU and updates state.reason.
//
export function runStep(dt, stepCPU, stepGPU) {
  // No GPU implementation yet? Always CPU.
  if (!stepGPU || !state.device) {
    if (state.active === 'gpu') {
      state.active = 'cpu'
      state.reason = 'GPU backend not implemented yet (CPU active)'
      emit()
    }
    stepCPU(dt)
    return
  }

  if (state.active === 'cpu') {
    stepCPU(dt)
    if (state.mode === 'auto' && state.gpuAvailable) {
      maybeProbeGpu(stepGPU)
    }
    return
  }

  // GPU path
  const t0 = performance.now()
  const promise = stepGPU(dt, state.device)
  // stepGPU may be sync (just queue.submit) or return a Promise that
  // resolves when GPU work is done. We don't await — we measure
  // submission-to-resolve in the background.
  if (promise && typeof promise.then === 'function') {
    promise.then(() => {
      const ms = performance.now() - t0
      recordSample(ms)
      considerAutoSwitch()
    }).catch((err) => {
      console.warn('GPU step failed, falling back to CPU:', err)
      state.active = 'cpu'
      state.reason = `GPU error: ${err.message || err}`
      emit()
    })
  } else {
    const ms = performance.now() - t0
    recordSample(ms)
    considerAutoSwitch()
  }
}

function considerAutoSwitch() {
  if (state.mode !== 'auto') return
  if (state.sampleCount < SAMPLE_WINDOW / 2) return
  const avg = averageGpuTime()
  if (state.active === 'gpu' && avg > CONTENTION_MS) {
    state.active = 'cpu'
    state.reason = `auto: GPU contended (${avg.toFixed(1)}ms avg), using CPU`
    state.lastProbeAt = performance.now()
    emit()
  }
}

function maybeProbeGpu(stepGPU) {
  // While in CPU fallback under 'auto', occasionally try a single
  // GPU step to check if the GPU has freed up.
  if (state.mode !== 'auto') return
  const now = performance.now()
  if (now - state.lastProbeAt < PROBE_INTERVAL_MS) return
  state.lastProbeAt = now
  const t0 = performance.now()
  const r = stepGPU(0, state.device)  // dt=0 == probe-only, no-op step
  const finish = () => {
    const ms = performance.now() - t0
    if (ms < RECOVERY_MS) {
      state.active = 'gpu'
      state.reason = `auto: GPU recovered (${ms.toFixed(1)}ms probe)`
      clearSamples()
      emit()
    }
  }
  if (r && typeof r.then === 'function') r.then(finish).catch(() => {})
  else finish()
}
