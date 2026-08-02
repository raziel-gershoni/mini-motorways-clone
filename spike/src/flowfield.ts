import { Sampler, type Stats } from './stats'

export const ORTHO_COST = 10
export const DIAG_COST = 14
export const INF = 0x7fffffff

/** Cyclic bucket count: one more than the largest edge weight. */
const NB = DIAG_COST + 1

const DX = [0, 1, 1, 1, 0, -1, -1, -1] as const
const DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const
/** Index of the direction pointing back the way we came. */
const OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3] as const

export interface FlowField {
  /** Weighted distance to the nearest source, or INF. */
  dist: Int32Array
  /** Index into DX/DY pointing one step toward a source; -1 at sources and unreachable cells. */
  dir: Int8Array
}

export interface FlowScratch {
  bucketHead: Int32Array
  entryCell: Int32Array
  entryNext: Int32Array
}

export function createFlowField(cells: number): FlowField {
  return { dist: new Int32Array(cells), dir: new Int8Array(cells) }
}

/**
 * Entry pool sized for at most 8 relaxations per cell plus one source insertion.
 * A per-cell `next` pointer would corrupt bucket lists when a cell's distance
 * improves while it is still linked into a higher bucket.
 */
export function createFlowScratch(cells: number): FlowScratch {
  const cap = cells * 9
  return {
    bucketHead: new Int32Array(NB),
    entryCell: new Int32Array(cap),
    entryNext: new Int32Array(cap),
  }
}

export function computeFlowField(
  w: number,
  h: number,
  passable: Uint8Array,
  sources: readonly number[],
  out: FlowField,
  scratch: FlowScratch,
): void {
  const n = w * h
  const { dist, dir } = out
  const { bucketHead, entryCell, entryNext } = scratch

  dist.fill(INF)
  dir.fill(-1)
  bucketHead.fill(-1)

  let top = 0
  let pending = 0

  const push = (cell: number, d: number): void => {
    const b = d % NB
    entryCell[top] = cell
    entryNext[top] = bucketHead[b] as number
    bucketHead[b] = top
    top++
    pending++
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i] as number
    if (s < 0 || s >= n || passable[s] === 0 || dist[s] === 0) continue
    dist[s] = 0
    push(s, 0)
  }

  for (let d = 0; pending > 0; d++) {
    const b = d % NB
    let e = bucketHead[b] as number
    bucketHead[b] = -1
    while (e !== -1) {
      const cur = entryCell[e] as number
      e = entryNext[e] as number
      pending--
      if (dist[cur] !== d) continue // stale entry from a later improvement

      const cx = cur % w
      const cy = (cur / w) | 0
      for (let k = 0; k < 8; k++) {
        const nx = cx + (DX[k] as number)
        const ny = cy + (DY[k] as number)
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (passable[ni] === 0) continue
        const nd = d + (DX[k] !== 0 && DY[k] !== 0 ? DIAG_COST : ORTHO_COST)
        if (nd < (dist[ni] as number)) {
          dist[ni] = nd
          dir[ni] = OPPOSITE[k] as number
          push(ni, nd)
        }
      }
    }
  }
}

/**
 * Measures a realistic per-tick pathfinding load: five colour fields over a
 * 24x40 grid, exactly as the production sim would rebuild them on a dirty tick.
 * Returns per-full-rebuild timings in milliseconds.
 */
export function probeFlowFields(iterations: number): Stats {
  const W = 24
  const H = 40
  const cells = W * H
  const COLOURS = 5

  const passable = new Uint8Array(cells).fill(1)
  // Scatter some impassable terrain so the search is not trivially uniform.
  for (let i = 0; i < cells; i += 17) passable[i] = 0

  const fields = Array.from({ length: COLOURS }, () => createFlowField(cells))
  const scratch = createFlowScratch(cells)
  const sources: number[][] = Array.from({ length: COLOURS }, (_, c) =>
    [3 + c * 7, cells - 40 - c * 11, (cells >> 1) + c * 5].filter((s) => passable[s] === 1),
  )

  const sampler = new Sampler(iterations)
  for (let it = 0; it < iterations; it++) {
    const t0 = performance.now()
    for (let c = 0; c < COLOURS; c++) {
      computeFlowField(W, H, passable, sources[c] as number[], fields[c] as FlowField, scratch)
    }
    sampler.push(performance.now() - t0)
  }
  return sampler.stats()
}
