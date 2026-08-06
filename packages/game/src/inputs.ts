import type { TickAction, TickActionKind, TickInputs } from '@laneways/sim'

/**
 * The pooled `TickAction` queue — plan Decision 9.
 *
 * `step` takes `inputs: TickInputs = { readonly actions: readonly TickAction[] }`
 * and `TickAction = { readonly kind, readonly a, readonly b }`: object types, in
 * a frame loop the plan says allocates nothing. A drag entering one tile per
 * `pointermove` would otherwise allocate one action object per tile plus one
 * wrapper object per tick, forever.
 *
 * **Nothing in `sim` changes for this.** A mutable array is assignable to
 * `readonly T[]`, and a `readonly` field modifier does not stop the *owner*
 * mutating through its own mutable-typed reference — so the pool needs no cast
 * anywhere. `PooledAction` below is structurally `TickAction` with the modifiers
 * dropped; `sim` only ever sees it through the `readonly` view.
 *
 * **Two invariants this type exists to hold, both of them tested:**
 *
 *   1. `inputs` is one object for the lifetime of the queue. `clear()` empties
 *      the array in place; it never replaces it and never replaces the wrapper.
 *   2. `enqueue` allocates only when the pool's high-water mark is exceeded,
 *      which a drag bounds — one pointer sample cannot enter unboundedly many
 *      tiles, and `pointer.ts` (Task 7) walks at most `max(|dx|, |dy|)` cells
 *      between samples.
 *
 * **The queue survives a zero-tick frame, and that is the whole reason it is a
 * queue rather than a per-frame array.** At 60 Hz half of all frames run zero
 * ticks and at 120 Hz three in four do (see `loop.ts`'s table), so the natural
 * wrong implementation — build this frame's actions, hand them to whatever
 * ticks run, discard — drops half to three quarters of a drag's segments.
 * `loop.ts` owns the clear and calls it only once a tick has actually consumed
 * the batch.
 *
 * The one allocation this module cannot avoid is inside the JS engine:
 * `actions.length = 0` followed by re-growth may re-trim and re-grow the
 * array's backing store. That is not an object this code creates and there is
 * no allocation-free array shape with a `.length` `step` can iterate, so it is
 * recorded rather than hidden.
 */

/** `TickAction` with its `readonly` modifiers dropped. Never exposed outside this module. */
interface PooledAction {
  kind: TickActionKind
  a: number
  b: number
}

/**
 * The queue `loop.ts` drains and `pointer.ts` (Task 7) fills.
 *
 * `inputs` is handed to `step` verbatim. `length` and `poolSize` are getters
 * over the live arrays rather than counters kept alongside them, so they cannot
 * disagree with what `step` will actually see.
 */
export interface InputQueue {
  /** The single `TickInputs` object every tick receives. Identity-stable forever. */
  readonly inputs: TickInputs
  /** Appends one action, writing into a pooled object. */
  readonly enqueue: (kind: TickActionKind, a: number, b: number) => void
  /** Empties the batch in place. Called by `loop.ts` after a tick has consumed it. */
  readonly clear: () => void
  /** How many actions are queued right now. */
  readonly length: number
  /** The pool's high-water mark, exposed so a test can assert that it stops growing. */
  readonly poolSize: number
}

/**
 * How many action objects are preallocated. A drag across a phone-sized
 * viewport enters at most a couple of dozen cells between two `pointermove`
 * samples in the worst case, and the pool grows past this without ceremony —
 * this is a starting size, not a limit.
 */
export const INPUT_POOL_INITIAL_CAPACITY = 32

export function createInputQueue(initialCapacity: number = INPUT_POOL_INITIAL_CAPACITY): InputQueue {
  const pool: PooledAction[] = []
  for (let i = 0; i < initialCapacity; i++) pool.push({ kind: 'place', a: 0, b: 0 })

  // `actions` and `pool` are deliberately separate arrays holding the same
  // objects: `actions.length` must equal the batch size (it is what `step`
  // iterates), while `pool.length` must only ever grow.
  const actions: PooledAction[] = []
  const inputs: TickInputs = { actions }

  return {
    inputs,

    enqueue(kind: TickActionKind, a: number, b: number): void {
      const n = actions.length
      if (n === pool.length) pool.push({ kind: 'place', a: 0, b: 0 })
      const action = pool[n] as PooledAction
      action.kind = kind
      action.a = a
      action.b = b
      actions.push(action)
    },

    // **A pop loop, and the shape is measured rather than stylistic.**
    //
    // The obvious `actions.length = 0` is a 152 B allocation per call, every
    // call: V8's length setter RIGHT-TRIMS the elements backing store, so the
    // next `push` re-grows it from zero and allocates a fresh 17-element
    // `FixedArray` (17 x 8 + 16 header = 152 bytes — the measurement matches to
    // the byte). `splice(0, n)` is worse: it also allocates the array of removed
    // elements it returns. `pop` does not trim, so the backing store stays at
    // the batch's high-water capacity and the whole cycle allocates **0.00
    // B/call**, measured over 200,000 clears of a 6-action batch.
    //
    // This module's first version said the re-growth was "the one allocation
    // this module cannot avoid ... there is no allocation-free array shape with
    // a `.length` `step` can iterate". That was wrong, and it was invisible for
    // a whole task because `test/allocation.test.ts` profiled an IDLE queue —
    // the loop drains an empty batch every tick, so `clear()` never had anything
    // to trim. Task 7 drove a live drag through the same harness and it showed
    // up immediately, at 64.30 B/frame charged to the inlined caller.
    clear(): void {
      for (let i = actions.length - 1; i >= 0; i--) actions.pop()
    },

    get length(): number {
      return actions.length
    },

    get poolSize(): number {
      return pool.length
    },
  }
}

/**
 * Compile-time proof that a pooled action is a `TickAction` and the pooled
 * array is a `TickInputs['actions']` — i.e. that the "mutable is assignable to
 * readonly" claim in the module comment holds rather than being asserted.
 * Dropping it would let a future `TickAction` field addition break the queue
 * only at the `step` call site.
 */
const _pooledIsTickAction: TickAction = { kind: 'place', a: 0, b: 0 } satisfies PooledAction
void _pooledIsTickAction
