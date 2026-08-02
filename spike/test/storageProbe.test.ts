import { describe, it, expect } from 'vitest'
import { runProbe, checkFreshContext, makePayload, PROBE_KEY, PAYLOAD_BYTES, type KVLike } from '../src/storageProbe'

class MemStore implements KVLike {
  readonly map = new Map<string, string>()
  failWrites = false
  failReads = false
  getItem(k: string): string | null {
    if (this.failReads) throw new Error('SecurityError')
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.map.set(k, v)
  }
}

describe('makePayload', () => {
  it('produces exactly the requested byte count', () => {
    expect(makePayload(4096)).toHaveLength(4096)
  })

  it('is deterministic', () => {
    expect(makePayload(64)).toBe(makePayload(64))
  })

  it('is not a single repeated character, so truncation is detectable', () => {
    const p = makePayload(256)
    expect(new Set(p).size).toBeGreaterThan(1)
  })
})

describe('runProbe', () => {
  it('reports a first launch when storage is empty', () => {
    const s = new MemStore()
    const r = runProbe(s, 1000)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
    expect(r.ageMs).toBe(0)
    expect(r.writeFailed).toBe(false)
    expect(r.payloadIntact).toBe(true)
  })

  it('writes the record on the first launch', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    expect(s.getItem(PROBE_KEY)).not.toBeNull()
  })

  it('reports survival and an incremented launch count on the second launch', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const r = runProbe(s, 61000)
    expect(r.survived).toBe(true)
    expect(r.launches).toBe(2)
    expect(r.ageMs).toBe(60000)
    expect(r.payloadIntact).toBe(true)
  })

  it('keeps counting across many launches', () => {
    const s = new MemStore()
    for (let i = 0; i < 4; i++) runProbe(s, 1000 + i)
    expect(runProbe(s, 2000).launches).toBe(5)
  })

  it('detects a corrupted payload', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const rec = JSON.parse(s.getItem(PROBE_KEY) as string)
    rec.payload = 'truncated'
    s.map.set(PROBE_KEY, JSON.stringify(rec))
    const r = runProbe(s, 2000)
    expect(r.survived).toBe(true)
    expect(r.payloadIntact).toBe(false)
  })

  it('treats unparseable stored data as a first launch', () => {
    const s = new MemStore()
    s.map.set(PROBE_KEY, 'not json {{{')
    const r = runProbe(s, 1000)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
  })

  it('reports writeFailed instead of throwing when the store rejects writes', () => {
    const s = new MemStore()
    s.failWrites = true
    const r = runProbe(s, 1000)
    expect(r.writeFailed).toBe(true)
    expect(r.survived).toBe(false)
  })

  it('stores a payload of PAYLOAD_BYTES length', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const rec = JSON.parse(s.getItem(PROBE_KEY) as string)
    expect(rec.payload).toHaveLength(PAYLOAD_BYTES)
  })

  it('does not throw when the store rejects reads', () => {
    const s = new MemStore()
    s.failReads = true
    expect(() => runProbe(s, 1000)).not.toThrow()
  })

  it('treats a rejected read as a first launch', () => {
    const s = new MemStore()
    s.failReads = true
    const r = runProbe(s, 1000)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
  })
})

describe('checkFreshContext', () => {
  it('reports a fresh context on first call', () => {
    expect(checkFreshContext(new MemStore())).toBe('yes')
  })

  it('reports a reused context on the second call against the same store', () => {
    const s = new MemStore()
    checkFreshContext(s)
    expect(checkFreshContext(s)).toBe('no')
  })

  it('reports unavailable when there is no store', () => {
    expect(checkFreshContext(null)).toBe('unavailable')
  })

  it('reports unavailable when the store throws on read', () => {
    const s = new MemStore()
    s.failReads = true
    expect(checkFreshContext(s)).toBe('unavailable')
  })

  it('reports unavailable when the store throws on write', () => {
    const s = new MemStore()
    s.failWrites = true
    expect(checkFreshContext(s)).toBe('unavailable')
  })
})
