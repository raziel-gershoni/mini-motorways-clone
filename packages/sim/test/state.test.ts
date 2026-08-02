import { describe, it, expect } from 'vitest'
import { createState, snapshot, restore, hashState, H_TICK, H_SCORE, H_WEEK } from '../src/state'
import { nextRandom } from '../src/rng'

describe('createState', () => {
  it('is deterministic for a given seed', () => {
    expect(hashState(createState('abc'))).toBe(hashState(createState('abc')))
  })

  it('differs across seeds', () => {
    expect(hashState(createState('abc'))).not.toBe(hashState(createState('abd')))
  })

  it('starts at tick 0, score 0, week 0', () => {
    const s = createState('x')
    expect(s.header[H_TICK]).toBe(0)
    expect(s.header[H_SCORE]).toBe(0)
    expect(s.header[H_WEEK]).toBe(0)
  })

  it('seeds the rng non-zero', () => {
    expect(createState('x').rng[0]).not.toBe(0)
  })
})

describe('snapshot and restore', () => {
  it('round-trips to an identical hash', () => {
    const s = createState('round-trip')
    s.header[H_TICK] = 1234
    s.header[H_SCORE] = 56
    const before = hashState(s)
    expect(hashState(restore(snapshot(s)))).toBe(before)
  })

  it('produces a detached copy — mutating the original does not change the snapshot', () => {
    const s = createState('detach')
    const snap = snapshot(s)
    s.header[H_TICK] = 9999
    expect(hashState(restore(snap))).not.toBe(hashState(s))
  })

  it('restores the rng stream position exactly', () => {
    const s = createState('rng-restore')
    nextRandom(s.rng, 0)
    nextRandom(s.rng, 0)
    const snap = snapshot(s)
    const expected = [nextRandom(s.rng, 0), nextRandom(s.rng, 0)]
    const r = restore(snap)
    expect([nextRandom(r.rng, 0), nextRandom(r.rng, 0)]).toEqual(expected)
  })

  it('restores a snapshot taken from a restored state', () => {
    const a = createState('nested')
    a.header[H_WEEK] = 3
    const b = restore(snapshot(a))
    const c = restore(snapshot(b))
    expect(hashState(c)).toBe(hashState(a))
  })
})

describe('hashState', () => {
  it('reflects a change to any header field', () => {
    for (const idx of [H_TICK, H_SCORE, H_WEEK]) {
      const s = createState('sensitivity')
      const before = hashState(s)
      s.header[idx] = (s.header[idx] as number) + 1
      expect(hashState(s), `header index ${idx} did not affect the hash`).not.toBe(before)
    }
  })

  it('reflects a change to the rng state', () => {
    const s = createState('rng-sensitivity')
    const before = hashState(s)
    nextRandom(s.rng, 0)
    expect(hashState(s)).not.toBe(before)
  })
})
