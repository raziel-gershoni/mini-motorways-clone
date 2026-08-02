/**
 * Declarative buffer layout.
 *
 * The state buffer grew hand-computed offsets in M1a, and a reviewer had to
 * verify by hand that two regions did not overlap or leave a gap. That does not
 * survive four regions.
 *
 * The hazard is alignment. Today's layout is [rng Uint32 x 1 @0, header Int32
 * x 3 @4] and is legal because both regions are 4-byte-aligned by construction.
 * The moment a byte region of odd length sits before a wider one it stops being
 * legal: the spec's own 43x35 = 1505 grid would put the next Int32 region at
 * 1521 and throw `RangeError: start offset of Int32Array should be a multiple
 * of 4`, naming neither the region nor the cause.
 *
 * Regions are declared; offsets are derived, padded to each region's own
 * alignment, and asserted.
 *
 * Padding lands INSIDE the hashed range, which M1a's reviewer certified was
 * free of dead bytes. That certification is superseded deliberately, not
 * accidentally: pad bytes are zero-initialised by `new ArrayBuffer`, copied
 * verbatim by `snapshot` and `restore`, and written by nothing, so they are
 * deterministic in every engine and contribute a constant to every hash.
 */

export type RegionCtor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor

export interface Region {
  readonly name: string
  readonly ctor: RegionCtor
  readonly len: number
}

export interface LayoutEntry extends Region {
  readonly offset: number
}

export interface Layout {
  readonly entries: readonly LayoutEntry[]
  readonly totalBytes: number
}

export function computeLayout(regions: readonly Region[]): Layout {
  // Membership only — never iterated, so spec §4.1's ban on Map/Set iteration
  // does not apply. Task 1's `no-collection-iteration` rule permits `has`/`add`
  // for exactly this reason, and would report a `for (const n of seen)`.
  const seen = new Set<string>()
  const entries: LayoutEntry[] = []
  let offset = 0
  // Starts at 4, not 1. Per-region padding already guarantees each region's own
  // alignment, so the tail is not about later appends — it is about the whole
  // buffer: `byteLength` must be a whole multiple of the widest element size
  // any view over it will use, or that view cannot be constructed. Every state
  // buffer carries at least one 4-byte region.
  let maxAlign = 4

  for (const r of regions) {
    if (seen.has(r.name)) throw new Error(`computeLayout: duplicate region name "${r.name}"`)
    seen.add(r.name)
    if (!Number.isInteger(r.len) || r.len < 0) {
      throw new Error(`computeLayout: region "${r.name}" has invalid length ${r.len}`)
    }
    const align = r.ctor.BYTES_PER_ELEMENT
    if (align > maxAlign) maxAlign = align
    const pad = (align - (offset % align)) % align
    offset += pad
    entries.push({ ...r, offset })
    offset += r.len * align
  }

  const tail = (maxAlign - (offset % maxAlign)) % maxAlign
  return { entries, totalBytes: offset + tail }
}
