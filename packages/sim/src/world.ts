import { TERRAIN, type MapData, type TerrainCode } from '@laneways/shared'
import { hashBytes } from './hash'
import { H_MAP, H_MAP_H, H_MAP_W, nonZeroWord, type GameState } from './state'

/**
 * The immutable board built from a `MapData`. Terrain itself never changes —
 * it is not in the state buffer, and `createWorld` allocates fresh typed
 * arrays on every call rather than caching one at module scope (Task 1's AST
 * rule would reject a module-scope typed array anyway).
 *
 * `terrain` is "immutable by contract, not by construction": `readonly`
 * protects the binding but not the contents, and `Object.freeze` cannot help
 * — freezing a non-empty typed array throws. Its immutability is therefore a
 * TESTED property (byte-for-byte, across a place/erase sequence in Task 3),
 * not a declared one. Trees the simulation destroys live in the state
 * buffer's `cleared` region instead (design decision 1) — never written here.
 */
export interface WorldData {
  readonly map: MapData
  readonly w: number
  readonly h: number
  readonly cells: number
  readonly terrain: Uint8Array
  readonly passable: Uint8Array
}

export function createWorld(map: MapData): WorldData {
  const cells = map.w * map.h
  const terrain = new Uint8Array(cells)
  const passable = new Uint8Array(cells)
  // Precomputed once, not per pathfinding query: `passable` is read on every
  // flow-field relaxation (Task 5), and recomputing it from `terrain` on
  // every read would be the dominant cost.
  for (let i = 0; i < cells; i++) {
    const code = map.terrain[i] as TerrainCode
    terrain[i] = code
    passable[i] = code === TERRAIN.LAND || code === TERRAIN.TREE ? 1 : 0
  }
  return { map, w: map.w, h: map.h, cells, terrain, passable }
}

/**
 * A signed, non-zero hash of a map's full content: id, dimensions,
 * `startingTiles`, and every terrain byte in cell-index order.
 *
 * Three defects a reviewed draft had, each closed here:
 *
 *   - Signedness. `hashBytes` returns `>>> 0` (unsigned), but `H_MAP` lives
 *     in an `Int32Array`. Storing the unsigned value and comparing against
 *     this function's return would false-reject a valid replay for every map
 *     hashing >= 2^31 — including the launch map. `| 0` reinterprets the
 *     32-bit pattern as signed, matching how the header reads it back.
 *   - Content-blindness. Hashing only `id` cannot detect a map edited between
 *     a run and its verification — the one drift this check exists to catch,
 *     and the entire justification for keeping terrain out of the snapshot
 *     (design decision 1). So every field that defines the board is hashed.
 *   - Zero. Nothing forced this away from 0, which is what a blank header
 *     slot already holds; `nonZeroWord` (shared with the rng seed path)
 *     forces it to 1 in that one case and leaves every other value alone.
 *
 * The byte recipe is exact, not incidental, because two engines (browser and
 * Worker) must agree on it bit-for-bit: the id's length as 4 LE bytes, then
 * each `charCodeAt(i)` as 2 LE bytes, then `w`, `h`, `startingTiles` as 4 LE
 * bytes each, then one byte per terrain code in cell-index order. The length
 * prefix is load-bearing, not decoration: without it, the boundary between a
 * variable-length id and the fixed fields is ambiguous and two different
 * maps can hash to the same byte stream (e.g. id "ab" + w=1 vs id "a" +
 * w=... colliding through a shifted boundary).
 */
export function mapIdHash(map: MapData): number {
  const idLength = map.id.length
  const bytes = new Uint8Array(4 + idLength * 2 + 4 + 4 + 4 + map.terrain.length)
  const view = new DataView(bytes.buffer)
  let offset = 0

  view.setUint32(offset, idLength, true)
  offset += 4
  for (let i = 0; i < idLength; i++) {
    view.setUint16(offset, map.id.charCodeAt(i), true)
    offset += 2
  }
  view.setUint32(offset, map.w, true)
  offset += 4
  view.setUint32(offset, map.h, true)
  offset += 4
  view.setUint32(offset, map.startingTiles, true)
  offset += 4
  for (let i = 0; i < map.terrain.length; i++) {
    bytes[offset + i] = map.terrain[i] as number
  }

  return nonZeroWord(hashBytes(bytes) | 0)
}

/**
 * The identity check that makes a frozen buffer layout safe to replay
 * against: `restore` calls this after the byte-length guard, so a
 * same-size, wrong-board buffer is still rejected. `H_MAP_W`/`H_MAP_H` are
 * checked independently of the content hash because a byte-length check
 * alone cannot distinguish 24x40 from 40x24 or 20x48 — all three are 960
 * cells, and every index would reinterpret geometrically with no error.
 */
export function assertWorldMatches(state: GameState, world: WorldData): void {
  const expectedHash = mapIdHash(world.map)
  if (state.header[H_MAP] !== expectedHash) {
    throw new Error(
      `assertWorldMatches: H_MAP mismatch for map "${world.map.id}" — state has ${state.header[H_MAP]}, world hashes to ${expectedHash}`,
    )
  }
  if (state.header[H_MAP_W] !== world.map.w) {
    throw new Error(
      `assertWorldMatches: H_MAP_W mismatch for map "${world.map.id}" — state has ${state.header[H_MAP_W]}, world has ${world.map.w}`,
    )
  }
  if (state.header[H_MAP_H] !== world.map.h) {
    throw new Error(
      `assertWorldMatches: H_MAP_H mismatch for map "${world.map.id}" — state has ${state.header[H_MAP_H]}, world has ${world.map.h}`,
    )
  }
}
