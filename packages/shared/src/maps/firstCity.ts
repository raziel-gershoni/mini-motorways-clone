import { parseMap, type MapData } from '../mapFormat'

/**
 * A fixture map, not the shipping map. Its job is to exercise every terrain
 * code and every placement rule — a river (with a bridgeable two-cell gap),
 * a mountain cluster, and scattered trees — not to be good level design.
 *
 * `w`/`h` here (24x40) are the map's *final* extent per design decision 5:
 * expansion (M1e — M1d declined it) reveals cells within this grid, it never
 * resizes the buffer, so this is the largest this board ever gets.
 *
 * Row data is `Object.freeze([...] as const)` at module scope — required by
 * Task 1's AST rule (`as const` alone is a type-level assertion with no
 * runtime effect) — and `firstCity()` calls `parseMap` at call time, so no
 * `MapData` or typed array is ever allocated at module scope.
 */
const ROWS = Object.freeze([
  '............~...........',
  '............~...........',
  '..T.........~...........',
  '........T...~...........',
  '............~.....T.....',
  '...^^.......~...........',
  '...^^.......~.......T...',
  '...^^.......~...........',
  '............~...........',
  '......T.....~...........',
  '............~...T.......',
  '............~...........',
  '..T.........~...........',
  '............~.........T.',
  '............~...........',
  '.........T..~...........',
  '............~...........',
  '............~......T....',
  '........................',
  '........................',
  '.....T......~...........',
  '............~....T......',
  '............~...........',
  '...T........~...........',
  '............~........T..',
  '............~...........',
  '..........T.~...........',
  '............~...........',
  '............~..T........',
  '............~...........',
  '.......T....~...........',
  '............~.........T.',
  '............~...........',
  '....T.......~...........',
  '............~.....T.....',
  '............~...........',
  '...........T~...........',
  '.T..........~...........',
  '............~.......T...',
  '............~T..........',
] as const)

export function firstCity(): MapData {
  return parseMap('firstCity', ROWS, 30, 40, 16, 5)
}
