export const MAX_BODY_BYTES = 65536

export interface ResultRow {
  receivedAt: number
  kind: string
  platform: string | null
  perfClass: string | null
  dpr: number | null
  ua: string | null
  body: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Pulls the handful of columns worth indexing out of a submission, keeping the
 * full body alongside. Never throws: a probe result that cannot be parsed is
 * still evidence, and losing it would defeat the point of durable storage.
 */
export function extractRow(body: string, nowMs: number): ResultRow {
  if (body.length > MAX_BODY_BYTES) {
    return {
      receivedAt: nowMs,
      kind: 'oversized',
      platform: null, perfClass: null, dpr: null, ua: null,
      body: body.slice(0, MAX_BODY_BYTES),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      receivedAt: nowMs,
      kind: 'unmarshalled',
      platform: null, perfClass: null, dpr: null, ua: null,
      body,
    }
  }

  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  const d = (typeof obj.device === 'object' && obj.device !== null ? obj.device : {}) as Record<string, unknown>

  return {
    receivedAt: nowMs,
    kind: str(obj.kind) ?? 'unknown',
    platform: str(d.platform),
    perfClass: str(d.performanceClass),
    dpr: num(d.dpr),
    ua: str(d.ua),
    body,
  }
}
