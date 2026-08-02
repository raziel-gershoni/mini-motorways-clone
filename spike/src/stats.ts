export interface Stats {
  count: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

/**
 * Nearest-rank percentiles. Uses Float64Array.sort, which is numeric —
 * Array.prototype.sort defaults to lexicographic and would be wrong here.
 */
export function percentiles(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error('percentiles: no samples')
  const sorted = Float64Array.from(samples)
  sorted.sort()
  const n = sorted.length
  const at = (q: number): number => sorted[Math.min(n - 1, Math.floor(q * n))] as number
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i] as number
  return {
    count: n,
    mean: sum / n,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[n - 1] as number,
  }
}

/** Fixed-capacity sample buffer. Allocates once; never grows during measurement. */
export class Sampler {
  private readonly buf: Float64Array
  private n = 0

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity)
  }

  push(v: number): void {
    if (this.n < this.buf.length) this.buf[this.n++] = v
  }

  get length(): number {
    return this.n
  }

  reset(): void {
    this.n = 0
  }

  stats(): Stats {
    return percentiles(Array.from(this.buf.subarray(0, this.n)))
  }
}
