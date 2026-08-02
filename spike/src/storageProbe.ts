export const PROBE_KEY = 'laneways.m0.probe'
export const CONTEXT_KEY = 'laneways.m0.context'
export const PAYLOAD_BYTES = 4096

export interface KVLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 'yes'  — this is a brand-new browsing context. Combined with survived:true it
 *          proves prior-session data was read from disk, which is the reading
 *          the crash-safety architecture actually depends on.
 * 'no'   — the WebView was reused. survived:true here proves nothing.
 * 'unavailable' — sessionStorage inaccessible; the row cannot discriminate.
 */
export type FreshContext = 'yes' | 'no' | 'unavailable'

export function checkFreshContext(store: KVLike | null): FreshContext {
  if (store === null) return 'unavailable'
  try {
    const seen = store.getItem(CONTEXT_KEY)
    store.setItem(CONTEXT_KEY, '1')
    return seen === null ? 'yes' : 'no'
  } catch {
    return 'unavailable'
  }
}

export interface ProbeResult {
  launches: number
  survived: boolean
  payloadIntact: boolean
  writeFailed: boolean
  ageMs: number
  firstSeenMs: number
}

interface Record_ {
  firstSeenMs: number
  launches: number
  payload: string
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Deterministic, non-uniform, so truncation or corruption is detectable. */
export function makePayload(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) {
    out += ALPHABET[(i * 7 + (i >> 5)) % ALPHABET.length]
  }
  return out
}

function parse(raw: string | null): Record_ | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as Partial<Record_>
    if (typeof v.firstSeenMs !== 'number' || typeof v.launches !== 'number' || typeof v.payload !== 'string') {
      return null
    }
    return { firstSeenMs: v.firstSeenMs, launches: v.launches, payload: v.payload }
  } catch {
    return null
  }
}

/**
 * Call once per launch. Returns whether a prior launch's data survived.
 * Never throws — a storage backend that rejects reads or writes reports the failure safely.
 */
export function runProbe(store: KVLike, nowMs: number): ProbeResult {
  const expected = makePayload(PAYLOAD_BYTES)
  let raw: string | null = null
  try {
    raw = store.getItem(PROBE_KEY)
  } catch {
    // Storage access restricted. Treat exactly as "no prior record".
  }
  const prior = parse(raw)

  const survived = prior !== null
  const payloadIntact = prior === null ? true : prior.payload === expected
  const launches = prior === null ? 1 : prior.launches + 1
  const firstSeenMs = prior === null ? nowMs : prior.firstSeenMs

  let writeFailed = false
  try {
    store.setItem(PROBE_KEY, JSON.stringify({ firstSeenMs, launches, payload: expected }))
  } catch {
    writeFailed = true
  }

  return {
    launches,
    survived,
    payloadIntact,
    writeFailed,
    ageMs: nowMs - firstSeenMs,
    firstSeenMs,
  }
}
