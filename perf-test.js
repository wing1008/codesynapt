// Performance test for the linked-list grid + RR springs version.
// Mirrors public/app.js step() exactly.

const MAX_NODES = 300_000
const SIZES = [1_000, 10_000, 30_000, 100_000, 300_000]
const FRAMES = 30

function makeSyntheticGraph(n) {
  const nodes = []
  const spread = Math.max(20, Math.sqrt(n) * 1.6)
  for (let i = 0; i < n; i++) {
    const r = 4 + Math.random() * spread
    const theta = Math.random() * Math.PI * 2
    nodes.push({
      id: 'f' + i, idx: i,
      p: { x: r * Math.cos(theta), y: (Math.random() - 0.5) * 8, z: r * Math.sin(theta) },
      v: { x: 0, y: 0, z: 0 },
      mass: 1 + Math.sqrt(Math.floor(Math.random() * 12)) * 1.6,
    })
  }
  const edges = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      const t = Math.floor(Math.random() * n)
      if (t !== i) edges.push({ s: nodes[i].id, t: nodes[t].id, k: 'import' })
    }
  }
  return { nodes, edges }
}

const GRID_CELL = 11
const GRID_INV = 1 / GRID_CELL
const GRID_SIZE_BITS = 6
const GRID_SIZE = 1 << GRID_SIZE_BITS
const GRID_MASK = GRID_SIZE - 1
const GRID_TOTAL = GRID_SIZE ** 3

const cellHead = new Int32Array(GRID_TOTAL)
const nextInCell = new Int32Array(MAX_NODES)

function buildGrid(arr) {
  cellHead.fill(-1)
  const n = arr.length
  for (let i = 0; i < n; i++) {
    const p = arr[i].p
    const cx = ((p.x * GRID_INV) | 0) & GRID_MASK
    const cy = ((p.y * GRID_INV) | 0) & GRID_MASK
    const cz = ((p.z * GRID_INV) | 0) & GRID_MASK
    const cell = (cx << (GRID_SIZE_BITS * 2)) | (cy << GRID_SIZE_BITS) | cz
    nextInCell[i] = cellHead[cell]
    cellHead[cell] = i
  }
}

let rrCursor = 0, springCursor = 0

function step(arr, edges, nodeMap, alpha = 0.3, dt = 0.016) {
  if (alpha === 0) return
  const n = arr.length
  const REPEL = 240, SPRING = 0.05, REST = 9
  const CENTER = 0.0018, DISK = 0.012
  const CUT2 = GRID_CELL * GRID_CELL * 2.25
  const VEL_KEEP = 0.62

  buildGrid(arr)

  const RR_CHUNK = Math.min(n, Math.max(4000, Math.floor(120_000 / Math.max(1, Math.log2(n)))))
  const PAIR_CAP_LOCAL = 32

  for (let k = 0; k < RR_CHUNK; k++) {
    const i = (rrCursor + k) % n
    const ni = arr[i]
    const aix = ni.p.x, aiy = ni.p.y, aiz = ni.p.z
    const aim = ni.mass, invMi = 1 / aim
    const cx = ((aix * GRID_INV) | 0) & GRID_MASK
    const cy = ((aiy * GRID_INV) | 0) & GRID_MASK
    const cz = ((aiz * GRID_INV) | 0) & GRID_MASK
    let count = 0

    for (let dx = -1; dx <= 1; dx++) {
      const ncx = (cx + dx) & GRID_MASK
      for (let dy = -1; dy <= 1; dy++) {
        const ncy = (cy + dy) & GRID_MASK
        for (let dz = -1; dz <= 1; dz++) {
          const ncz = (cz + dz) & GRID_MASK
          const cell = (ncx << (GRID_SIZE_BITS * 2)) | (ncy << GRID_SIZE_BITS) | ncz
          let j = cellHead[cell]
          while (j !== -1) {
            if (j === i) { j = nextInCell[j]; continue }
            const nj = arr[j]
            const ex = aix - nj.p.x, ey = aiy - nj.p.y, ez = aiz - nj.p.z
            const d2 = ex*ex + ey*ey + ez*ez
            if (d2 > CUT2 || d2 < 0.0001) { j = nextInCell[j]; continue }
            const safeD2 = d2 < 0.5 ? 0.5 : d2
            const invD = 1 / Math.sqrt(d2)
            const f = REPEL * aim * nj.mass / safeD2 * alpha * 0.5
            const fx = ex * invD * f, fy = ey * invD * f, fz = ez * invD * f
            ni.v.x += fx * invMi; ni.v.y += fy * invMi; ni.v.z += fz * invMi
            const invMj = 1 / nj.mass
            nj.v.x -= fx * invMj; nj.v.y -= fy * invMj; nj.v.z -= fz * invMj
            if (++count > PAIR_CAP_LOCAL) { dx = 2; dy = 2; dz = 2; break }
            j = nextInCell[j]
          }
        }
      }
    }
  }
  rrCursor = (rrCursor + RR_CHUNK) % n

  const eLen = edges.length
  if (eLen > 0) {
    const SPRING_CHUNK = Math.min(eLen, Math.max(8000, Math.floor(200_000 / Math.max(1, Math.log2(eLen)))))
    const springAlpha = alpha * Math.min(1, eLen / SPRING_CHUNK)
    for (let k = 0; k < SPRING_CHUNK; k++) {
      const idx = (springCursor + k) % eLen
      const e = edges[idx]
      const na = nodeMap.get(e.s), nb = nodeMap.get(e.t)
      if (!na || !nb) continue
      const ex = nb.p.x - na.p.x, ey = nb.p.y - na.p.y, ez = nb.p.z - na.p.z
      const d2 = ex*ex + ey*ey + ez*ez
      if (d2 < 1e-6) continue
      const d = Math.sqrt(d2)
      const f = SPRING * (d - REST) * springAlpha / d
      const fx = ex * f, fy = ey * f, fz = ez * f
      const inv1 = 1 / na.mass, inv2 = 1 / nb.mass
      na.v.x += fx * inv1; na.v.y += fy * inv1; na.v.z += fz * inv1
      nb.v.x -= fx * inv2; nb.v.y -= fy * inv2; nb.v.z -= fz * inv2
    }
    springCursor = (springCursor + SPRING_CHUNK) % eLen
  }

  const CA = CENTER * alpha, DA = DISK * alpha, DT6 = dt * 6
  for (let i = 0; i < n; i++) {
    const node = arr[i]
    const p = node.p, v = node.v
    v.x += -p.x * CA
    v.y += -p.y * CA - p.y * DA
    v.z += -p.z * CA
    v.x *= VEL_KEEP; v.y *= VEL_KEEP; v.z *= VEL_KEEP
    p.x += v.x * DT6; p.y += v.y * DT6; p.z += v.z * DT6
  }
}

function writeBuffers(arr) {
  const n = arr.length
  const positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions[i*3]   = arr[i].p.x
    positions[i*3+1] = arr[i].p.y
    positions[i*3+2] = arr[i].p.z
  }
}

console.log('Performance test — flat grid + RR repulsion + RR springs + inlined math')
console.log('Targets: <16ms=60fps, <33ms=30fps, <100ms=10fps\n')
console.log('              SIMULATING (during first ~5s of layout)   SETTLED (steady state)')
console.log('              ─────────────────────────────────────     ─────────────────────')

function stepSettled(arr, dt = 0.016) {
  // Mirror app.js settled-state fast path (alpha == 0)
  const n = arr.length
  for (let i = 0; i < n; i++) {
    const v = arr[i].v
    if (v.x * v.x + v.y * v.y + v.z * v.z < 0.0002) { v.x = 0; v.y = 0; v.z = 0; continue }
    v.x *= 0.62; v.y *= 0.62; v.z *= 0.62
    const p = arr[i].p
    p.x += v.x * dt * 6; p.y += v.y * dt * 6; p.z += v.z * dt * 6
  }
}

for (const N of SIZES) {
  const { nodes, edges } = makeSyntheticGraph(N)
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  rrCursor = 0; springCursor = 0

  // Warm-up
  step(nodes, edges, nodeMap, 0.3)
  step(nodes, edges, nodeMap, 0.3)

  // Active simulation
  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    step(nodes, edges, nodeMap, 0.3)
    writeBuffers(nodes)
  }
  const msSim = (performance.now() - t0) / FRAMES

  // Settled — zero velocity, just buffer write
  for (const node of nodes) { node.v.x = 0; node.v.y = 0; node.v.z = 0 }
  const t1 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    stepSettled(nodes)
    writeBuffers(nodes)
  }
  const msSettled = (performance.now() - t1) / FRAMES

  const v1 = msSim < 18 ? '🟢' : msSim < 34 ? '🟡' : msSim < 105 ? '🟠' : '🔴'
  const v2 = msSettled < 18 ? '🟢' : msSettled < 34 ? '🟡' : msSettled < 105 ? '🟠' : '🔴'
  console.log(`${N.toString().padStart(7)} nodes  ${msSim.toFixed(1).padStart(6)} ms (${(1000/msSim).toFixed(0).padStart(3)} fps) ${v1}    ${msSettled.toFixed(1).padStart(6)} ms (${(1000/msSettled).toFixed(0).padStart(3)} fps) ${v2}`)
}
