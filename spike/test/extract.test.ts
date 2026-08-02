import { describe, it, expect } from 'vitest'
import { extractRow, MAX_BODY_BYTES } from '../worker/extract'

const FULL = JSON.stringify({
  kind: 'bench',
  device: { platform: 'ios', performanceClass: null, dpr: 3, ua: 'Mozilla/5.0 iPhone' },
  results: [{ sprites: 400 }],
})

describe('extractRow', () => {
  it('pulls the indexed columns out of a well-formed payload', () => {
    const r = extractRow(FULL, 1000)
    expect(r.receivedAt).toBe(1000)
    expect(r.kind).toBe('bench')
    expect(r.platform).toBe('ios')
    expect(r.perfClass).toBeNull()
    expect(r.dpr).toBe(3)
    expect(r.ua).toBe('Mozilla/5.0 iPhone')
  })

  it('preserves the original body verbatim', () => {
    expect(extractRow(FULL, 1000).body).toBe(FULL)
  })

  it('falls back to kind "unknown" when kind is absent', () => {
    expect(extractRow('{"device":{}}', 1).kind).toBe('unknown')
  })

  it('falls back to kind "unknown" when kind is not a string', () => {
    expect(extractRow('{"kind":42}', 1).kind).toBe('unknown')
  })

  it('nulls every device column when device is absent', () => {
    const r = extractRow('{"kind":"storage"}', 1)
    expect(r.kind).toBe('storage')
    expect(r.platform).toBeNull()
    expect(r.perfClass).toBeNull()
    expect(r.dpr).toBeNull()
    expect(r.ua).toBeNull()
  })

  it('nulls device columns of the wrong type rather than coercing', () => {
    const r = extractRow('{"kind":"x","device":{"platform":7,"dpr":"3","ua":null}}', 1)
    expect(r.platform).toBeNull()
    expect(r.dpr).toBeNull()
    expect(r.ua).toBeNull()
  })

  it('survives malformed JSON, still storing the raw body', () => {
    const r = extractRow('not json {{{', 5)
    expect(r.kind).toBe('unmarshalled')
    expect(r.body).toBe('not json {{{')
    expect(r.receivedAt).toBe(5)
  })

  it('survives a JSON scalar rather than an object', () => {
    const r = extractRow('42', 5)
    expect(r.kind).toBe('unknown')
    expect(r.platform).toBeNull()
  })

  it('survives JSON null without throwing', () => {
    expect(() => extractRow('null', 5)).not.toThrow()
    expect(extractRow('null', 5).kind).toBe('unknown')
  })

  it('truncates a body over the size cap and marks it', () => {
    const huge = JSON.stringify({ kind: 'bench', pad: 'x'.repeat(MAX_BODY_BYTES) })
    const r = extractRow(huge, 1)
    expect(r.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES)
    expect(r.kind).toBe('oversized')
  })
})
