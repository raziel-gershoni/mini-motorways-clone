import { Sampler, type Stats } from './stats'
import { makeScene, advance, type Sprite } from './scene'
import { buildRoadAtlas, randomRoadMasks } from './roadAtlas'

export interface BenchConfig {
  sprites: number
  baked: boolean
}

export interface BenchResult {
  sprites: number
  baked: boolean
  dpr: number
  cssW: number
  cssH: number
  tilePx: number
  frame: Stats
  draw: Stats
  /** Per-draw cost from a batched pass with a forced GPU sync. Resolvable
   *  where the per-frame `draw` percentiles are not: see DRAW_BATCH. */
  drawBatchMs: number
}

const CONFIGS: readonly BenchConfig[] = [
  { sprites: 100, baked: true },
  { sprites: 200, baked: true },
  { sprites: 400, baked: true },
  { sprites: 800, baked: true },
  { sprites: 400, baked: false },
]

const GRID_W = 24
const GRID_H = 40
const WARMUP_FRAMES = 30
const MEASURE_FRAMES = 180
const DRAW_BATCH = 20
const SPRITE_COLORS = ['#f2b544', '#e5544f', '#54b8e5', '#4a6fa8', '#5cc47f']

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

export async function runBenchSuite(
  canvas: HTMLCanvasElement,
  onProgress: (msg: string) => void,
): Promise<BenchResult[]> {
  // Let layout settle before reading clientWidth/Height. Reading them on the
  // same frame the canvas was appended can yield 0 and silently benchmark a
  // zero-area surface, which looks like excellent performance.
  await nextFrame()

  const dpr = window.devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (cssW < 1 || cssH < 1) throw new Error(`bench: canvas has no area (${cssW}x${cssH})`)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('bench: no 2d context')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const tilePx = Math.floor(Math.min(cssW / GRID_W, cssH / GRID_H))
  // A 0px tile makes drawImage from a 0x0 atlas tile throw an opaque
  // InvalidStateError; fail with something a reader can act on instead.
  if (tilePx < 1) throw new Error(`bench: canvas too small for a ${GRID_W}x${GRID_H} grid (${cssW}x${cssH})`)
  const masks = randomRoadMasks(GRID_W * GRID_H, 1234)
  const atlas = buildRoadAtlas(tilePx, dpr, '#f4f2ee')

  // The baked layer: the whole road network drawn once into an offscreen canvas.
  const baked = document.createElement('canvas')
  baked.width = canvas.width
  baked.height = canvas.height
  const bctx = baked.getContext('2d')
  if (!bctx) throw new Error('bench: no 2d context for baked canvas')
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawRoads(bctx, atlas, masks, tilePx)

  const results: BenchResult[] = []

  for (const cfg of CONFIGS) {
    onProgress(`bench ${cfg.sprites} sprites, roads ${cfg.baked ? 'baked' : 'per-frame'}…`)
    const sprites = makeScene(cfg.sprites, cssW, cssH, 2024)
    const frame = new Sampler(MEASURE_FRAMES)
    const draw = new Sampler(MEASURE_FRAMES)

    let prev = await nextFrame()
    for (let i = 0; i < WARMUP_FRAMES + MEASURE_FRAMES; i++) {
      const now = await nextFrame()
      // rawDt feeds the frame sampler unclamped: a GC pause or thermal stall
      // is exactly what the p95/p99/max tail exists to catch, and clamping
      // it here would silently record any stall over 250ms as 250ms. dt is
      // clamped only for advance(), so a stall doesn't fling sprites across
      // the canvas — that clamp must never leak into the measurement.
      const rawDt = (now - prev) / 1000
      const dt = Math.min(0.25, rawDt)
      prev = now

      advance(sprites, dt, cssW, cssH)

      const t0 = performance.now()
      drawFrame(ctx, baked, cfg.baked, atlas, masks, tilePx, sprites, cssW, cssH)
      const t1 = performance.now()

      if (i >= WARMUP_FRAMES) {
        draw.push(t1 - t0)
        frame.push(rawDt * 1000)
      }
    }

    // The per-frame `draw` samples above are timed against performance.now(),
    // which WebKit clamps to 1 ms — at these costs that yields only 0 or 1 and
    // no signal. Drawing DRAW_BATCH times back to back lifts the measured
    // interval well above the clock floor. The trailing getImageData forces a
    // GPU sync inside the timed region, so this measures raster cost rather
    // than the cost of merely enqueuing commands. Sprites deliberately do not
    // move between iterations: this measures draw cost, not simulation, and
    // holding them still keeps the batch identical to the per-frame work.
    const b0 = performance.now()
    for (let k = 0; k < DRAW_BATCH; k++) {
      drawFrame(ctx, baked, cfg.baked, atlas, masks, tilePx, sprites, cssW, cssH)
    }
    ctx.getImageData(0, 0, 1, 1)
    const drawBatchMs = (performance.now() - b0) / DRAW_BATCH

    results.push({
      sprites: cfg.sprites,
      baked: cfg.baked,
      dpr,
      cssW,
      cssH,
      tilePx,
      frame: frame.stats(),
      draw: draw.stats(),
      drawBatchMs,
    })
  }

  return results
}

/**
 * One frame's worth of drawing. Extracted so the batched pass and the
 * per-frame measure loop cannot drift apart: draw order, fill colour and
 * sprite radius must stay identical for the two numbers to be comparable.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  baked: HTMLCanvasElement,
  useBaked: boolean,
  atlas: readonly HTMLCanvasElement[],
  masks: Uint8Array,
  tilePx: number,
  sprites: readonly Sprite[],
  cssW: number,
  cssH: number,
): void {
  ctx.fillStyle = '#e9e4dc'
  ctx.fillRect(0, 0, cssW, cssH)
  if (useBaked) {
    ctx.drawImage(baked, 0, 0, cssW, cssH)
  } else {
    drawRoads(ctx, atlas, masks, tilePx)
  }
  drawSprites(ctx, sprites, tilePx)
}

function drawRoads(
  ctx: CanvasRenderingContext2D,
  atlas: readonly HTMLCanvasElement[],
  masks: Uint8Array,
  tilePx: number,
): void {
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i] as number
    if (m === 0) continue
    const x = (i % GRID_W) * tilePx
    const y = ((i / GRID_W) | 0) * tilePx
    ctx.drawImage(atlas[m] as HTMLCanvasElement, x, y, tilePx, tilePx)
  }
}

function drawSprites(ctx: CanvasRenderingContext2D, sprites: readonly Sprite[], tilePx: number): void {
  const r = Math.max(3, tilePx * 0.3)
  // One composited shadow layer would go here in production; the spike draws
  // sprites only, so the measured cost is a lower bound on the real renderer.
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite
    ctx.fillStyle = SPRITE_COLORS[s.group] as string
    ctx.beginPath()
    ctx.roundRect(s.x - r, s.y - r, r * 2, r * 2, r * 0.35)
    ctx.fill()
  }
}
