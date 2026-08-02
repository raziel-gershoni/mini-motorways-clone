import { mulberry32 } from './scene'

/** 8 directions, index 0 = N, clockwise. Bit i of a tile mask means "road toward DIRS[i]". */
export const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],  // 0 N
  [1, -1],  // 1 NE
  [1, 0],   // 2 E
  [1, 1],   // 3 SE
  [0, 1],   // 4 S
  [-1, 1],  // 5 SW
  [-1, 0],  // 6 W
  [-1, -1], // 7 NW
] as const

export function dirsOf(mask: number): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = []
  for (let i = 0; i < 8; i++) if (mask & (1 << i)) out.push(DIRS[i] as readonly [number, number])
  return out
}

/** Plausible-looking road coverage for the benchmark. Not a real city. */
export function randomRoadMasks(cells: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed)
  const out = new Uint8Array(cells)
  for (let i = 0; i < cells; i++) {
    // ~45% of cells carry road; those that do get 2-3 directions.
    if (rnd() < 0.45) {
      let m = 0
      const n = 2 + (rnd() < 0.4 ? 1 : 0)
      for (let k = 0; k < n; k++) m |= 1 << Math.floor(rnd() * 8)
      out[i] = m
    }
  }
  return out
}

/**
 * Pre-renders all 256 direction configurations once, at device pixel ratio.
 * This is the whole point: per-frame road drawing becomes drawImage, and the
 * joins are correct by construction rather than by stroke luck.
 */
export function buildRoadAtlas(tilePx: number, dpr: number, road: string): HTMLCanvasElement[] {
  const px = Math.round(tilePx * dpr)
  const atlas: HTMLCanvasElement[] = new Array(256)
  for (let mask = 0; mask < 256; mask++) {
    const c = document.createElement('canvas')
    c.width = px
    c.height = px
    const g = c.getContext('2d')
    if (g) {
      g.scale(dpr, dpr)
      g.strokeStyle = road
      g.lineWidth = tilePx * 0.6
      g.lineCap = 'round'
      g.lineJoin = 'round'
      const half = tilePx / 2
      const dirs = dirsOf(mask)
      if (dirs.length > 0) {
        g.beginPath()
        for (const [dx, dy] of dirs) {
          g.moveTo(half, half)
          g.lineTo(half + dx * half, half + dy * half)
        }
        g.stroke()
      }
    }
    atlas[mask] = c
  }
  return atlas
}
