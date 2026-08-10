import { describe, it, expect } from 'vitest'
import { TICKS_PER_WEEK, WEEKLY_TILE_GRANT, parseMap } from '@laneways/shared'
import { createState, H_TICK, H_TILES, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFlowFields, createScratch, type FlowField, type Scratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { step, type TickInputs } from '../src/step'
import { roadMask } from '../src/roads'
import { runWeekBoundary } from '../src/week'

const NO_INPUT: TickInputs = { actions: [] }

/**
 * A 4x4 all-land board. Building-free by construction — nothing here places a
 * house or a destination — so the only thing that can move `H_TILES` is the
 * grant under test or a road this file lays deliberately.
 */
const MAP = parseMap('week-test-map', ['....', '....', '....', '....'], 20, 8, 4, 2)
const WORLD = createWorld(MAP)

/**
 * The two cells the boundary-tick placement uses. Adjacent (0,0)-(1,0) on the
 * 4-wide board, and **both virgin**, which is what makes the segment cost 2
 * rather than 1. The test asserts that rather than trusting this comment.
 */
const BOUNDARY_A = 0
const BOUNDARY_B = 1

interface Rig {
  readonly state: GameState
  readonly world: WorldData
  readonly fields: readonly FlowField[]
  readonly scratch: Scratch
}

function rig(id: string): Rig {
  return {
    state: createState(id, MAP),
    world: WORLD,
    fields: createFlowFields(MAP.groupCount, WORLD.cells),
    scratch: createScratch(WORLD.cells, MAP.groupCount, MAP.maxDestinations, createFieldInputRanges(MAP)),
  }
}

describe('the weekly tile grant', () => {
  it('grants exactly WEEKLY_TILE_GRANT on a boundary tick and nothing on any other', () => {
    const { state } = rig('week-grant')
    const before = state.header[H_TILES] as number
    state.header[H_TICK] = TICKS_PER_WEEK - 1
    runWeekBoundary(state)
    expect(state.header[H_TILES], 'the tick before a boundary grants nothing').toBe(before)
    state.header[H_TICK] = TICKS_PER_WEEK
    runWeekBoundary(state)
    expect(state.header[H_TILES]).toBe(before + WEEKLY_TILE_GRANT)
    state.header[H_TICK] = TICKS_PER_WEEK + 1
    runWeekBoundary(state)
    expect(state.header[H_TILES], 'the tick after a boundary grants nothing').toBe(
      before + WEEKLY_TILE_GRANT,
    )
  })

  it('grants once per week over three weeks driven through step, not through the helper', () => {
    // Driven through `step` so the PHASE is exercised, not only the function:
    // a phase that is never called is indistinguishable from dead code, and
    // the counters will not say so.
    const r = rig('week-grant-stepped')
    const before = r.state.header[H_TILES] as number
    for (let i = 0; i < TICKS_PER_WEEK * 3; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_TILES]).toBe(before + 3 * WEEKLY_TILE_GRANT)
  })

  it('grants before inputs are applied, so a boundary-tick placement can spend the new tiles', () => {
    // The fixture is built so the placement is affordable ONLY with the grant:
    // tiles are drained to zero first, then one road is queued on the exact
    // boundary tick. Without the ordering the placement is refused for budget.
    //
    // The residue is 28, not 29: `canPlaceRoad` (roads.ts:404) prices a
    // segment as the number of its two endpoint cells whose mask is currently
    // 0, so the FIRST segment on a fresh board costs **2**. The rig lays one
    // segment on virgin cells, so 30 - 2 = 28. Getting this wrong by one is
    // how a test passes for the wrong reason: at `- 1` the assertion is
    // satisfied by no implementation at all and the test is simply red, which
    // is the benign direction — but the same slip in the other direction
    // (pre-roading one endpoint without saying so) would make it green while
    // measuring a 1-tile segment. So the two-virgin-endpoint premise the 2
    // rests on is ASSERTED here rather than described above.
    const r = rig('week-grant-order')
    expect(roadMask(r.state, BOUNDARY_A), 'endpoint A must be virgin, or the segment costs 1').toBe(0)
    expect(roadMask(r.state, BOUNDARY_B), 'endpoint B must be virgin, or the segment costs 1').toBe(0)
    r.state.header[H_TILES] = 0
    r.state.header[H_TICK] = TICKS_PER_WEEK - 1
    step(r.state, r.world, r.fields, r.scratch, {
      actions: [{ kind: 'place', a: BOUNDARY_A, b: BOUNDARY_B }],
    })
    expect(r.state.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(roadMask(r.state, BOUNDARY_A), 'the boundary-tick placement must have landed').not.toBe(0)
    expect(r.state.header[H_TILES]).toBe(WEEKLY_TILE_GRANT - 2)
  })
})
