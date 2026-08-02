import { describe, it, expect } from 'vitest'
import {
  ORTHO_COST, DIAG_COST, INF,
  createFlowField, createFlowScratch, computeFlowField,
} from '../src/flowfield'

function run(w: number, h: number, blocked: readonly number[], sources: readonly number[]) {
  const cells = w * h
  const passable = new Uint8Array(cells).fill(1)
  for (const b of blocked) passable[b] = 0
  const field = createFlowField(cells)
  const scratch = createFlowScratch(cells)
  computeFlowField(w, h, passable, sources, field, scratch)
  return field
}

describe('computeFlowField', () => {
  it('gives distance 0 at the source', () => {
    const f = run(3, 3, [], [4])
    expect(f.dist[4]).toBe(0)
  })

  it('costs 10 orthogonally and 14 diagonally from a centre source', () => {
    const f = run(3, 3, [], [4])
    // 0 1 2
    // 3 4 5
    // 6 7 8
    expect(f.dist[1]).toBe(ORTHO_COST)
    expect(f.dist[3]).toBe(ORTHO_COST)
    expect(f.dist[5]).toBe(ORTHO_COST)
    expect(f.dist[7]).toBe(ORTHO_COST)
    expect(f.dist[0]).toBe(DIAG_COST)
    expect(f.dist[2]).toBe(DIAG_COST)
    expect(f.dist[6]).toBe(DIAG_COST)
    expect(f.dist[8]).toBe(DIAG_COST)
  })

  it('leaves unreachable cells at INF', () => {
    // 1x3 row with the middle blocked: cell 2 is unreachable from cell 0.
    const f = run(3, 1, [1], [0])
    expect(f.dist[0]).toBe(0)
    expect(f.dist[1]).toBe(INF)
    expect(f.dist[2]).toBe(INF)
  })

  it('routes around an obstacle rather than through it', () => {
    // 3x3, block the centre (1,1). Distance from 3=(0,1) to 5=(2,1).
    // Shortest legal route is 3=(0,1) -> 1=(1,0) -> 5=(2,1): two diagonals, 28.
    const f = run(3, 3, [4], [3])
    expect(f.dist[4]).toBe(INF)
    expect(f.dist[5]).toBe(2 * DIAG_COST)
  })

  it('permits corner-cutting past a blocked diagonal neighbour', () => {
    // Documents a deliberate choice: a diagonal step is legal even when the
    // two orthogonal cells flanking it are blocked. Real roads are explicit
    // graph edges, so this never arises in the production sim, but the probe
    // grid would silently measure a different workload if this changed.
    const f = run(3, 3, [1, 3], [0])
    expect(f.dist[4]).toBe(DIAG_COST)
  })

  it('takes the minimum over multiple sources', () => {
    const f = run(5, 1, [], [0, 4])
    expect(f.dist[0]).toBe(0)
    expect(f.dist[1]).toBe(ORTHO_COST)
    expect(f.dist[2]).toBe(2 * ORTHO_COST)
    expect(f.dist[3]).toBe(ORTHO_COST)
    expect(f.dist[4]).toBe(0)
  })

  it('prefers a diagonal over two orthogonals', () => {
    // Straight-line distance from 0 to 8 on a 3x3 is two diagonals = 28,
    // never four orthogonals = 40.
    const f = run(3, 3, [], [0])
    expect(f.dist[8]).toBe(2 * DIAG_COST)
  })

  it('sets dir to -1 at sources and to a valid direction elsewhere', () => {
    const f = run(3, 3, [], [4])
    expect(f.dir[4]).toBe(-1)
    for (const c of [0, 1, 2, 3, 5, 6, 7, 8]) {
      expect(f.dir[c]).toBeGreaterThanOrEqual(0)
      expect(f.dir[c]).toBeLessThan(8)
    }
  })

  it('ignores impassable sources', () => {
    const f = run(3, 1, [0], [0])
    expect(f.dist[0]).toBe(INF)
  })

  it('is reusable — a second run overwrites the first', () => {
    const cells = 9
    const passable = new Uint8Array(cells).fill(1)
    const field = createFlowField(cells)
    const scratch = createFlowScratch(cells)
    computeFlowField(3, 3, passable, [0], field, scratch)
    expect(field.dist[8]).toBe(2 * DIAG_COST)
    computeFlowField(3, 3, passable, [8], field, scratch)
    expect(field.dist[8]).toBe(0)
    expect(field.dist[0]).toBe(2 * DIAG_COST)
  })

  it('handles a full 24x40 grid without overflowing the entry pool', () => {
    const f = run(24, 40, [], [0])
    expect(f.dist[24 * 40 - 1]).toBeLessThan(INF)
  })
})
