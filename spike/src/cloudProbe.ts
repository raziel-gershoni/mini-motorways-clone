export const CLOUD_KEY = 'laneways_m0_cloud'
/** Throwaway key written only to measure write latency when the read fails,
 *  so a failed read never re-seeds (and thereby destroys) the durability
 *  record at CLOUD_KEY. */
export const CLOUD_WRITE_PROBE_KEY = 'laneways_m0_cloud_w'
export const CLOUD_PAYLOAD_CHARS = 3500
export const CLOUD_TIMEOUT_MS = 10000
/** Telegram's hard cap, applied to the whole stored value — wrapper included. */
export const CLOUD_VALUE_LIMIT = 4096

/** Structural subset of Telegram's CloudStorage. Callback style: (err, value). */
export interface CloudLike {
  getItem(key: string, cb: (err: string | null, value?: string) => void): void
  setItem(key: string, value: string, cb: (err: string | null, ok?: boolean) => void): void
}

export type OpOutcome = 'ok' | 'error' | 'timeout'

export interface CloudProbeResult {
  supported: boolean
  readOutcome: OpOutcome
  readError: string | null
  readMs: number
  writeOutcome: OpOutcome
  writeError: string | null
  writeMs: number
  survived: boolean
  payloadIntact: boolean
  launches: number
  ageMs: number
  firstSeenMs: number
  /** True when this launch wrote the durability record. False when the read
   *  failed and only the throwaway latency key was written, leaving the
   *  accumulated record intact. Without this, a row after a transient read
   *  failure is indistinguishable from real data loss. */
  wroteDurabilityRecord: boolean
}

interface CloudRecord {
  firstSeenMs: number
  launches: number
  payload: string
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Same deterministic non-uniform pattern as the localStorage probe, so a
 *  truncated or partially-written value is detectable rather than plausible. */
export function makeCloudPayload(chars: number): string {
  let out = ''
  for (let i = 0; i < chars; i++) out += ALPHABET[(i * 7 + (i >> 5)) % ALPHABET.length]
  return out
}

interface OpResult<T> { outcome: OpOutcome; error: string | null; value?: T; ms: number }

/**
 * Wraps one callback-style CloudStorage call. Resolves exactly once: on the
 * callback, or on the timeout, whichever comes first. A callback that never
 * fires is a real failure mode of a network-backed API and must be reported
 * distinctly — a `try` around the call itself would not catch it.
 */
function callOnce<T>(
  timeoutMs: number,
  invoke: (cb: (err: string | null, value?: T) => void) => void,
): Promise<OpResult<T>> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let settled = false
    const finish = (r: Omit<OpResult<T>, 'ms'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...r, ms: performance.now() - t0 })
    }
    const timer = setTimeout(() => finish({ outcome: 'timeout', error: null }), timeoutMs)
    try {
      invoke((err, value) => {
        if (err) finish({ outcome: 'error', error: String(err) })
        else finish({ outcome: 'ok', error: null, value })
      })
    } catch (e) {
      finish({ outcome: 'error', error: String(e) })
    }
  })
}

function parse(raw: string | undefined | null): CloudRecord | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const v = JSON.parse(raw) as Partial<CloudRecord>
    if (typeof v.firstSeenMs !== 'number' || typeof v.launches !== 'number' || typeof v.payload !== 'string') return null
    return { firstSeenMs: v.firstSeenMs, launches: v.launches, payload: v.payload }
  } catch {
    return null
  }
}

/** Never throws and never hangs. Call once per launch. */
export async function runCloudProbe(
  cloud: CloudLike | null,
  nowMs: number,
  timeoutMs: number = CLOUD_TIMEOUT_MS,
): Promise<CloudProbeResult> {
  const expected = makeCloudPayload(CLOUD_PAYLOAD_CHARS)
  const base: CloudProbeResult = {
    supported: cloud !== null,
    readOutcome: 'error', readError: null, readMs: 0,
    writeOutcome: 'error', writeError: null, writeMs: 0,
    survived: false, payloadIntact: true, launches: 1, ageMs: 0, firstSeenMs: nowMs,
    wroteDurabilityRecord: false,
  }
  if (cloud === null) return base

  const read = await callOnce<string>(timeoutMs, (cb) => cloud.getItem(CLOUD_KEY, cb))
  const prior = read.outcome === 'ok' ? parse(read.value) : null

  const survived = prior !== null
  const launches = prior === null ? 1 : prior.launches + 1
  const firstSeenMs = prior === null ? nowMs : prior.firstSeenMs
  const payloadIntact = prior === null ? true : prior.payload === expected

  // A failed read must never mutate the durability record: `prior` is null
  // whenever the read didn't succeed, so writing to CLOUD_KEY in that case
  // would re-seed it at launches: 1 and silently destroy the accumulated
  // evidence — indistinguishable from the data loss this probe measures.
  // Write latency is still worth measuring on every launch, so a failed read
  // writes a same-shaped throwaway payload to a separate key instead.
  const wroteDurabilityRecord = read.outcome === 'ok'
  const writeKey = wroteDurabilityRecord ? CLOUD_KEY : CLOUD_WRITE_PROBE_KEY
  const record: CloudRecord = { firstSeenMs, launches, payload: expected }
  const write = await callOnce<boolean>(timeoutMs, (cb) => cloud.setItem(writeKey, JSON.stringify(record), cb))

  // Telegram's setItem callback is (err, stored). A `stored === false` carrying
  // no error is a write that did not happen, and reporting it as 'ok' would be
  // the same silent failure the timeout handling above exists to prevent.
  // Strict equality, so a client that omits the second argument is not mistaken
  // for a rejection. Applies to whichever key was written above.
  const rejected = write.outcome === 'ok' && write.value === false

  return {
    supported: true,
    readOutcome: read.outcome, readError: read.error, readMs: read.ms,
    writeOutcome: rejected ? 'error' : write.outcome,
    writeError: rejected ? 'setItem reported not stored' : write.error,
    writeMs: write.ms,
    survived, payloadIntact, launches, ageMs: nowMs - firstSeenMs, firstSeenMs,
    wroteDurabilityRecord,
  }
}
