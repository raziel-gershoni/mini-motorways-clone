import { describe, it, expect } from 'vitest'
import {
  runCloudProbe,
  makeCloudPayload,
  CLOUD_KEY,
  CLOUD_WRITE_PROBE_KEY,
  CLOUD_PAYLOAD_CHARS,
  CLOUD_VALUE_LIMIT,
  type CloudLike,
} from '../src/cloudProbe'
import { PROBE_KEY } from '../src/storageProbe'

/** Short enough to keep the hang tests fast, long enough that a microtask-
 *  delivered callback always beats it. */
const FAST_TIMEOUT = 20

/**
 * Stands in for Telegram's CloudStorage. Callbacks are delivered asynchronously
 * because the real API is one MTProto round trip — a fake that called back
 * synchronously would not exercise the same ordering.
 */
class FakeCloud implements CloudLike {
  readonly map = new Map<string, string>()
  getError: string | null = null
  setError: string | null = null
  /** Callback never fires — the failure mode a try/catch cannot see. */
  hangGet = false
  hangSet = false
  throwOnGet = false
  /** Second argument of the setItem callback. `false` means "not stored". */
  stored: boolean | undefined = true
  /** Fire the getItem callback a second time, with an error. */
  doubleGet = false
  /** Callback value for a present key, overridable to test odd client shapes. */
  overrideGetValue: string | undefined | null = null
  reads = 0
  writes = 0
  lastWritten: string | null = null

  getItem(key: string, cb: (err: string | null, value?: string) => void): void {
    this.reads++
    if (this.throwOnGet) throw new Error('CloudStorage unavailable')
    if (this.hangGet) return
    // Telegram returns an empty string, not null, for a key that is not set.
    const value = this.overrideGetValue !== null ? this.overrideGetValue : (this.map.get(key) ?? '')
    queueMicrotask(() => {
      if (this.getError) cb(this.getError)
      else cb(null, value)
      if (this.doubleGet) cb('late error that must be ignored')
    })
  }

  setItem(key: string, value: string, cb: (err: string | null, ok?: boolean) => void): void {
    this.writes++
    this.lastWritten = value
    if (this.hangSet) return
    if (!this.setError) this.map.set(key, value)
    queueMicrotask(() => {
      if (this.setError) cb(this.setError)
      else cb(null, this.stored)
    })
  }
}

describe('makeCloudPayload', () => {
  it('produces exactly the requested character count', () => {
    expect(makeCloudPayload(CLOUD_PAYLOAD_CHARS)).toHaveLength(CLOUD_PAYLOAD_CHARS)
  })

  it('is deterministic', () => {
    expect(makeCloudPayload(64)).toBe(makeCloudPayload(64))
  })

  it('is not a single repeated character, so truncation is detectable', () => {
    expect(new Set(makeCloudPayload(256)).size).toBeGreaterThan(1)
  })
})

describe('CLOUD_KEY', () => {
  it('matches the CloudStorage key charset', () => {
    expect(CLOUD_KEY).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })

  it('does not reuse the dotted localStorage key, which the charset rejects', () => {
    expect(PROBE_KEY).not.toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(CLOUD_KEY).not.toContain('.')
  })
})

describe('CLOUD_WRITE_PROBE_KEY', () => {
  it('matches the CloudStorage key charset', () => {
    expect(CLOUD_WRITE_PROBE_KEY).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })

  it('is distinct from the durability record key', () => {
    expect(CLOUD_WRITE_PROBE_KEY).not.toBe(CLOUD_KEY)
  })
})

describe('the encoded record', () => {
  it('fits inside the 4096-char whole-value limit', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1.7e12, FAST_TIMEOUT)
    expect(c.lastWritten).not.toBeNull()
    expect((c.lastWritten as string).length).toBeLessThan(CLOUD_VALUE_LIMIT)
  })

  it('still fits with an implausibly large launch count and timestamp', () => {
    const encoded = JSON.stringify({
      firstSeenMs: 9999999999999,
      launches: 999999999,
      payload: makeCloudPayload(CLOUD_PAYLOAD_CHARS),
    })
    expect(encoded.length).toBeLessThan(CLOUD_VALUE_LIMIT)
  })
})

describe('runCloudProbe', () => {
  it('reports a first launch against an empty store', async () => {
    const r = await runCloudProbe(new FakeCloud(), 1000, FAST_TIMEOUT)
    expect(r.supported).toBe(true)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
    expect(r.ageMs).toBe(0)
    expect(r.payloadIntact).toBe(true)
    expect(r.readOutcome).toBe('ok')
    expect(r.writeOutcome).toBe('ok')
    expect(r.readError).toBeNull()
    expect(r.writeError).toBeNull()
  })

  it('writes the record on the first launch', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(c.writes).toBe(1)
    expect(JSON.parse(c.map.get(CLOUD_KEY) as string).payload).toHaveLength(CLOUD_PAYLOAD_CHARS)
  })

  it('reports survival, an incremented launch count and the age on the second launch', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    const r = await runCloudProbe(c, 1000 + 19 * 60_000, FAST_TIMEOUT)
    expect(r.survived).toBe(true)
    expect(r.launches).toBe(2)
    expect(r.ageMs).toBe(19 * 60_000)
    expect(r.firstSeenMs).toBe(1000)
    expect(r.payloadIntact).toBe(true)
  })

  it('keeps counting across many launches', async () => {
    const c = new FakeCloud()
    for (let i = 0; i < 4; i++) await runCloudProbe(c, 1000 + i, FAST_TIMEOUT)
    expect((await runCloudProbe(c, 2000, FAST_TIMEOUT)).launches).toBe(5)
  })

  it('detects a corrupted stored payload', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    const rec = JSON.parse(c.map.get(CLOUD_KEY) as string)
    rec.payload = 'truncated'
    c.map.set(CLOUD_KEY, JSON.stringify(rec))
    const r = await runCloudProbe(c, 2000, FAST_TIMEOUT)
    expect(r.survived).toBe(true)
    expect(r.payloadIntact).toBe(false)
  })

  it('treats unparseable stored JSON as a first launch', async () => {
    const c = new FakeCloud()
    c.map.set(CLOUD_KEY, 'not json {{{')
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
    expect(r.readOutcome).toBe('ok')
  })

  it('treats the empty string Telegram returns for a missing key as a first launch', async () => {
    const c = new FakeCloud()
    c.overrideGetValue = ''
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
  })

  it('treats a callback with no value argument as a first launch', async () => {
    const c = new FakeCloud()
    c.overrideGetValue = undefined
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.survived).toBe(false)
    expect(r.readOutcome).toBe('ok')
  })

  it('reports a getItem error and still attempts the write', async () => {
    const c = new FakeCloud()
    c.getError = 'WEBAPP_DATA_INVALID'
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('error')
    expect(r.readError).toBe('WEBAPP_DATA_INVALID')
    expect(r.survived).toBe(false)
    expect(c.writes).toBe(1)
    expect(r.writeOutcome).toBe('ok')
  })

  it('reports a getItem that throws synchronously as an error, not a crash', async () => {
    const c = new FakeCloud()
    c.throwOnGet = true
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('error')
    expect(r.readError).toContain('CloudStorage unavailable')
    expect(c.writes).toBe(1)
  })

  it('reports a setItem error while still reporting the read results', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    c.setError = 'FLOOD_WAIT'
    const r = await runCloudProbe(c, 2000, FAST_TIMEOUT)
    expect(r.writeOutcome).toBe('error')
    expect(r.writeError).toBe('FLOOD_WAIT')
    expect(r.readOutcome).toBe('ok')
    expect(r.survived).toBe(true)
    expect(r.launches).toBe(2)
  })

  it('reports a setItem that answers "not stored" as an error, not a success', async () => {
    const c = new FakeCloud()
    c.stored = false
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.writeOutcome).toBe('error')
    expect(r.writeError).toBe('setItem reported not stored')
  })

  it('treats a setItem callback that omits the stored flag as a success', async () => {
    const c = new FakeCloud()
    c.stored = undefined
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.writeOutcome).toBe('ok')
    expect(r.writeError).toBeNull()
  })

  it('reports a getItem whose callback never fires as a timeout, and still resolves', async () => {
    const c = new FakeCloud()
    c.hangGet = true
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('timeout')
    expect(r.readError).toBeNull()
    expect(r.readMs).toBeGreaterThan(0)
    expect(c.writes).toBe(1)
    expect(r.writeOutcome).toBe('ok')
  })

  it('reports a setItem whose callback never fires as a timeout', async () => {
    const c = new FakeCloud()
    c.hangSet = true
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.writeOutcome).toBe('timeout')
    expect(r.writeError).toBeNull()
    expect(r.readOutcome).toBe('ok')
  })

  it('never touches the durability record when the read times out, writing the throwaway key instead', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    const priorRaw = c.map.get(CLOUD_KEY)
    c.hangGet = true
    const r = await runCloudProbe(c, 2000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('timeout')
    expect(r.wroteDurabilityRecord).toBe(false)
    expect(c.map.get(CLOUD_KEY)).toBe(priorRaw)
    expect(c.map.has(CLOUD_WRITE_PROBE_KEY)).toBe(true)
  })

  it('never touches the durability record when the read errors, writing the throwaway key instead', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT)
    const priorRaw = c.map.get(CLOUD_KEY)
    c.getError = 'WEBAPP_DATA_INVALID'
    const r = await runCloudProbe(c, 2000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('error')
    expect(r.wroteDurabilityRecord).toBe(false)
    expect(c.map.get(CLOUD_KEY)).toBe(priorRaw)
    expect(c.map.has(CLOUD_WRITE_PROBE_KEY)).toBe(true)
  })

  it('writes the durability record and leaves the throwaway key untouched when the read succeeds', async () => {
    const c = new FakeCloud()
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('ok')
    expect(r.wroteDurabilityRecord).toBe(true)
    expect(c.map.has(CLOUD_KEY)).toBe(true)
    expect(c.map.has(CLOUD_WRITE_PROBE_KEY)).toBe(false)
  })

  it('still measures write latency when the read fails', async () => {
    const c = new FakeCloud()
    c.hangGet = true
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.wroteDurabilityRecord).toBe(false)
    expect(r.writeOutcome).toBe('ok')
    expect(Number.isFinite(r.writeMs)).toBe(true)
    expect(r.writeMs).toBeGreaterThanOrEqual(0)
  })

  it('preserves launches and firstSeenMs across a failed read followed by a successful one — the regression this fix prevents', async () => {
    const c = new FakeCloud()
    await runCloudProbe(c, 1000, FAST_TIMEOUT) // launches: 1, firstSeenMs: 1000
    await runCloudProbe(c, 2000, FAST_TIMEOUT) // launches: 2
    await runCloudProbe(c, 3000, FAST_TIMEOUT) // launches: 3

    c.hangGet = true
    const failed = await runCloudProbe(c, 4000, FAST_TIMEOUT)
    expect(failed.readOutcome).toBe('timeout')
    expect(failed.wroteDurabilityRecord).toBe(false)

    c.hangGet = false
    const recovered = await runCloudProbe(c, 5000, FAST_TIMEOUT)
    expect(recovered.readOutcome).toBe('ok')
    expect(recovered.survived).toBe(true)
    expect(recovered.launches).toBe(4)
    expect(recovered.firstSeenMs).toBe(1000)
  })

  it('settles once when a callback fires twice', async () => {
    const c = new FakeCloud()
    c.doubleGet = true
    const r = await runCloudProbe(c, 1000, FAST_TIMEOUT)
    expect(r.readOutcome).toBe('ok')
    expect(r.readError).toBeNull()
    // The late second callback must not have been able to re-run the write.
    expect(c.writes).toBe(1)
  })

  it('measures read and write separately', async () => {
    const r = await runCloudProbe(new FakeCloud(), 1000, FAST_TIMEOUT)
    expect(Number.isFinite(r.readMs)).toBe(true)
    expect(Number.isFinite(r.writeMs)).toBe(true)
    expect(r.readMs).toBeGreaterThanOrEqual(0)
    expect(r.writeMs).toBeGreaterThanOrEqual(0)
  })

  it('reports unsupported without throwing when CloudStorage is absent', async () => {
    const r = await runCloudProbe(null, 1000, FAST_TIMEOUT)
    expect(r.supported).toBe(false)
    expect(r.launches).toBe(1)
    expect(r.ageMs).toBe(0)
    expect(r.firstSeenMs).toBe(1000)
    expect(r.survived).toBe(false)
  })
})
