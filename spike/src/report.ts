export function show(title: string, data: unknown): void {
  const app = document.getElementById('app')
  if (!app) return
  const h = document.createElement('div')
  h.textContent = title
  h.style.cssText = 'margin:12px 0 4px;font-weight:600;color:#8ab4f8'
  const pre = document.createElement('pre')
  pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  app.append(h, pre)
}

export function status(text: string): void {
  const app = document.getElementById('app')
  if (app && app.textContent === 'booting…') app.textContent = ''
  show('status', text)
}

/** Never throws. Returns whether the POST succeeded. */
export async function submit(payload: unknown): Promise<boolean> {
  try {
    const res = await fetch('/api/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}
