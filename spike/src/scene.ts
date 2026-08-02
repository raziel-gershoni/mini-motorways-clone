export interface Sprite {
  x: number
  y: number
  vx: number
  vy: number
  group: number
}

export const GROUP_COUNT = 5

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    let t = (s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeScene(count: number, w: number, h: number, seed: number): Sprite[] {
  const rnd = mulberry32(seed)
  const out: Sprite[] = new Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = {
      x: rnd() * w,
      y: rnd() * h,
      vx: (rnd() - 0.5) * 120,
      vy: (rnd() - 0.5) * 120,
      group: Math.floor(rnd() * GROUP_COUNT),
    }
  }
  return out
}

export function advance(sprites: Sprite[], dt: number, w: number, h: number): void {
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite
    s.x += s.vx * dt
    s.y += s.vy * dt
    if (s.x < 0) { s.x = 0; s.vx = -s.vx }
    else if (s.x > w) { s.x = w; s.vx = -s.vx }
    if (s.y < 0) { s.y = 0; s.vy = -s.vy }
    else if (s.y > h) { s.y = h; s.vy = -s.vy }
  }
}
