interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/result' && req.method === 'POST') {
      const body = await req.text()
      // Surfaces in `pnpm tail` while a phone runs the spike.
      console.log('M0-RESULT', body)
      return new Response('ok', {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      })
    }
    return env.ASSETS.fetch(req)
  },
}
