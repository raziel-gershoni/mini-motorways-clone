import { extractRow } from './extract'

/** Structural subset of D1Database — avoids pulling in a types package for a spike. */
interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> }
  }
}

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  DB: D1Like
}

const INSERT =
  `INSERT INTO results (received_at, kind, platform, perf_class, dpr, ua, body)
   VALUES (?, ?, ?, ?, ?, ?, ?)`

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/result' && req.method === 'POST') {
      let body: string
      try {
        body = await req.text()
      } catch {
        // Stream error mid-read — there is nothing to store, but the phone must not
        // see a failure and rerun the sequence.
        return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
      }
      // Logged as well as stored: `wrangler tail` stays useful when someone is
      // watching live, and it is the fallback record if the insert fails.
      console.log('M0-RESULT', body)

      const row = extractRow(body, Date.now())
      try {
        await env.DB.prepare(INSERT)
          .bind(row.receivedAt, row.kind, row.platform, row.perfClass, row.dpr, row.ua, row.body)
          .run()
      } catch (err) {
        console.log('M0-RESULT-DB-ERROR', String(err))
        // Deliberately still 200. A failure here must not make the phone show a
        // failed submit — the person holding it would redo the whole sequence,
        // and the console log above already preserves the data.
      }

      return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
    }
    return env.ASSETS.fetch(req)
  },
}
