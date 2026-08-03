import { describe, it, expect } from 'vitest'
import { firstCity } from '@laneways/shared'
import { computeLayout, type LayoutEntry } from '../src/layout'
import {
  regionsFor,
  FIELD_INPUT_REGIONS,
  FIELD_IRRELEVANT_REGIONS,
  isFieldInputRegion,
  isFieldIrrelevantRegion,
  createFieldInputRanges,
} from '../src/regions'
import { createState, type GameState } from '../src/state'
import { createWorld } from '../src/world'
import { hashFieldInputRegions } from '../src/flowfield'
import { createFlowFields, createScratch } from '../src/scratch'
import { step } from '../src/step'

/**
 * `regions.ts` declares the whole M1c buffer shape and the FIELD_INPUT /
 * FIELD_IRRELEVANT partition over it. This file proves three properties the
 * plan calls out explicitly:
 *
 *   - The partition is exhaustive and non-overlapping over the REAL region
 *     list, compared as sets (a harmless reorder of either array must not
 *     fail this).
 *   - The staleness hash is driven FROM the layout table, not from a
 *     hand-written sequence that classification and hashing could silently
 *     diverge from — proven by poking one byte in every single region and
 *     checking the hash moves iff that region is FIELD_INPUT.
 *   - The layout has zero padding for `firstCity`'s real sizes.
 */

const MAP = firstCity()

describe('regionsFor', () => {
  it('is exported — the union assertion below could not compile against a module-private function (fix-list #5)', () => {
    expect(typeof regionsFor).toBe('function')
  })

  it('has zero padding for firstCity (960 cells): totalBytes === sum(len * BYTES_PER_ELEMENT)', () => {
    const regions = regionsFor(MAP)
    const declaredBytes = regions.reduce((sum, r) => sum + r.len * r.ctor.BYTES_PER_ELEMENT, 0)
    const { totalBytes } = computeLayout(regions)
    expect(totalBytes).toBe(declaredBytes)
  })

  it('totals exactly 7,908 bytes for firstCity, per the plan\'s region table', () => {
    const { totalBytes } = computeLayout(regionsFor(MAP))
    expect(totalBytes).toBe(7908)
  })

  it('declares exactly the 22 named regions the plan lists, no more and no fewer', () => {
    const names = regionsFor(MAP).map((r) => r.name)
    expect(names).toEqual([
      'rng',
      'mapIdentity',
      'header',
      'pinAccum',
      'rotationCursor',
      'houseCell',
      'destCell',
      'destSpawnTick',
      'carHome',
      'carCell',
      'carProgress',
      'carTargetDest',
      'carRouteLen',
      'carRouteCursor',
      'roads',
      'cleared',
      'houseColour',
      'destMeta',
      'destPins',
      'destReserved',
      'carPhase',
      'carRoute',
    ])
  })
})

describe('FIELD_INPUT / FIELD_IRRELEVANT partition', () => {
  it('is exhaustive and non-overlapping over regionsFor(firstCity()), compared as SETS', () => {
    // Sets, not arrays: a harmless reorder of either partition array (or of
    // regionsFor's declaration order) must not fail this — only a genuine
    // classification gap or overlap should.
    const declaredNames = new Set(regionsFor(MAP).map((r) => r.name))
    const inputNames = new Set<string>(FIELD_INPUT_REGIONS)
    const irrelevantNames = new Set<string>(FIELD_IRRELEVANT_REGIONS)

    for (const n of inputNames) {
      expect(irrelevantNames.has(n), `"${n}" is classified in BOTH partitions`).toBe(false)
    }

    const union = new Set<string>([...inputNames, ...irrelevantNames])
    expect(union).toEqual(declaredNames)
  })

  it('every classified name is a real declared region — a stale entry in either partition array would otherwise hide silently', () => {
    const declaredNames = new Set(regionsFor(MAP).map((r) => r.name))
    for (const n of FIELD_INPUT_REGIONS) {
      expect(declaredNames.has(n), `"${n}" (FIELD_INPUT) is not a declared region`).toBe(true)
    }
    for (const n of FIELD_IRRELEVANT_REGIONS) {
      expect(declaredNames.has(n), `"${n}" (FIELD_IRRELEVANT) is not a declared region`).toBe(true)
    }
  })

  it('isFieldInputRegion / isFieldIrrelevantRegion agree with the arrays they scan, and reject an unknown name', () => {
    for (const n of FIELD_INPUT_REGIONS) {
      expect(isFieldInputRegion(n)).toBe(true)
      expect(isFieldIrrelevantRegion(n)).toBe(false)
    }
    for (const n of FIELD_IRRELEVANT_REGIONS) {
      expect(isFieldIrrelevantRegion(n)).toBe(true)
      expect(isFieldInputRegion(n)).toBe(false)
    }
    expect(isFieldInputRegion('not-a-real-region')).toBe(false)
    expect(isFieldIrrelevantRegion('not-a-real-region')).toBe(false)
  })

  it('FIELD_INPUT_REGIONS is exactly {mapIdentity, destCell, roads, destMeta, destPins} — the plan\'s stated defence-in-depth set', () => {
    expect(new Set<string>(FIELD_INPUT_REGIONS)).toEqual(
      new Set(['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins']),
    )
  })
})

describe('the staleness hash is driven from the layout table, not a hand-written sequence', () => {
  // Parameterised over every single declared region: for each one, poke one
  // byte and check `hashFieldInputRegions` moves iff that region is
  // FIELD_INPUT. This is the test that catches "classified FIELD_INPUT but
  // forgotten in the hash" (unreachable here BY CONSTRUCTION, since
  // `createFieldInputRanges` derives its ranges from `isFieldInputRegion`
  // directly — but this test is what would catch a regression back to a
  // hand-written `hashBytes(s.roads)`, `hashBytes(s.destPins)`, ... sequence
  // that silently omitted one).
  const world = createWorld(MAP)
  const ranges = createFieldInputRanges(MAP)
  const { entries } = computeLayout(regionsFor(MAP))

  function freshState(): GameState {
    return createState('regions-poke-seed', MAP)
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LayoutEntry
    const isInput = isFieldInputRegion(e.name)
    const byteLength = e.len * e.ctor.BYTES_PER_ELEMENT

    it(`${e.name} (${isInput ? 'FIELD_INPUT' : 'FIELD_IRRELEVANT'}, ${byteLength} B): a poked byte ${isInput ? 'moves' : 'does not move'} hashFieldInputRegions`, () => {
      expect(byteLength, `${e.name} has no bytes to poke`).toBeGreaterThan(0)

      const s = freshState()
      const bytes = new Uint8Array(s.buffer)
      const before = hashFieldInputRegions(s, ranges)

      const pokeOffset = e.offset
      const beforeByte = bytes[pokeOffset] as number
      bytes[pokeOffset] = (beforeByte + 1) & 0xff

      // Vacuity self-check (fix-list #30): the poked byte must have
      // genuinely moved before asserting anything about its effect on the
      // hash — an aliased or out-of-range write would otherwise make either
      // branch below pass for the wrong reason.
      expect(bytes[pokeOffset], `${e.name}: the poked byte did not actually change`).not.toBe(beforeByte)

      const after = hashFieldInputRegions(s, ranges)
      if (isInput) {
        expect(after, `${e.name} is FIELD_INPUT but the hash did not move`).not.toBe(before)
      } else {
        expect(after, `${e.name} is FIELD_IRRELEVANT but the hash moved anyway`).toBe(before)
      }
    })
  }

  it('world.cells sanity: every entry above actually belongs to the region list this test enumerates', () => {
    expect(entries.length).toBe(regionsFor(MAP).length)
    expect(world.cells).toBe(MAP.w * MAP.h)
  })
})

describe('createFieldInputRanges', () => {
  it('covers exactly the FIELD_INPUT regions by count and by total bytes', () => {
    const { entries } = computeLayout(regionsFor(MAP))
    const inputEntries = entries.filter((e) => isFieldInputRegion(e.name))
    const ranges = createFieldInputRanges(MAP)

    expect(ranges.length).toBe(inputEntries.length * 2) // one (offset, length) pair per input region
    expect(inputEntries.length).toBe(FIELD_INPUT_REGIONS.length)

    let totalFromRanges = 0
    for (let i = 1; i < ranges.length; i += 2) totalFromRanges += ranges[i] as number
    const totalFromEntries = inputEntries.reduce((sum, e) => sum + e.len * e.ctor.BYTES_PER_ELEMENT, 0)
    expect(totalFromRanges).toBe(totalFromEntries)
    expect(totalFromRanges).toBeGreaterThan(0) // vacuity: the input set is not empty
  })

  it('emits (offset, length) pairs matching each FIELD_INPUT region\'s real layout offset and byte length, in declaration order', () => {
    const { entries } = computeLayout(regionsFor(MAP))
    const inputEntries = entries.filter((e) => isFieldInputRegion(e.name))
    const ranges = createFieldInputRanges(MAP)
    for (let i = 0; i < inputEntries.length; i++) {
      const e = inputEntries[i] as LayoutEntry
      expect(ranges[i * 2], `${e.name} offset`).toBe(e.offset)
      expect(ranges[i * 2 + 1], `${e.name} length`).toBe(e.len * e.ctor.BYTES_PER_ELEMENT)
    }
  })

  it('is an Int32Array', () => {
    expect(createFieldInputRanges(MAP)).toBeInstanceOf(Int32Array)
  })
})

describe('fieldInputRanges is built once, not recomputed per tick', () => {
  it('the same Scratch.fieldInputRanges reference survives many step() calls unchanged', () => {
    // A partial proxy for "nothing allocates inside a tick" (see this file's
    // report for the honest limit of what this specific test can and cannot
    // catch): it fails if `scratch.fieldInputRanges` is ever REASSIGNED to a
    // freshly-built array, which is the shape a naive "just recompute it
    // every tick" mistake would take at the call site that owns `scratch`.
    const world = createWorld(MAP)
    const state = createState('ranges-identity-seed', MAP)
    const fields = createFlowFields(MAP.groupCount, world.cells)
    const ranges = createFieldInputRanges(MAP)
    const scratch = createScratch(world.cells, MAP.groupCount, MAP.maxDestinations, ranges)
    for (let i = 0; i < 50; i++) step(state, world, fields, scratch, { actions: [] })
    expect(scratch.fieldInputRanges).toBe(ranges)
  })
})
