export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  LUXVM_ACCESS_KEY: string
  ALLOWED_ORIGINS?: string
}

const MODEL = '@cf/black-forest-labs/flux-2-klein-4b'
const DEFAULT_ORIGINS = ['https://ricecrackerlol.github.io', 'null']

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map((item) => item.trim())
  const permittedOrigin = origin && allowed.includes(origin) ? origin : 'null'
  return {
    'Access-Control-Allow-Origin': permittedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...Object.fromEntries(new Headers(headers)), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function decodeDataUrl(value: string): { bytes: Uint8Array; type: string } {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('Reference image must be a PNG, JPEG, or WebP data URL.')
  const binary = atob(match[2])
  if (binary.length > 8 * 1024 * 1024) throw new Error('Reference image must be 8 MB or smaller after resizing.')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { bytes, type: match[1] }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const headers = corsHeaders(origin, env)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, headers)

    const allowedOrigins = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map((item) => item.trim())
    if (origin && !allowedOrigins.includes(origin)) return json({ error: 'Origin not allowed.' }, 403, headers)
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !env.LUXVM_ACCESS_KEY) {
      return json({ error: 'Worker secrets are not configured.' }, 503, headers)
    }
    if (request.headers.get('Authorization') !== `Bearer ${env.LUXVM_ACCESS_KEY}`) {
      return json({ error: 'Unauthorized. Check the Worker access key in LuxVM Settings.' }, 401, headers)
    }

    try {
      const body = await request.json() as { prompt?: string; width?: number; height?: number; referenceImage?: string | null }
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt || prompt.length > 4000) return json({ error: 'Prompt must contain between 1 and 4,000 characters.' }, 400, headers)
      const width = Number(body.width || 1024)
      const height = Number(body.height || 1024)
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256 || width > 1920 || height > 1920) {
        return json({ error: 'Image dimensions must be whole numbers between 256 and 1920.' }, 400, headers)
      }

      const form = new FormData()
      form.append('prompt', prompt)
      form.append('width', String(width))
      form.append('height', String(height))
      if (body.referenceImage) {
        const reference = decodeDataUrl(body.referenceImage)
        const extension = reference.type === 'image/jpeg' ? 'jpg' : reference.type === 'image/webp' ? 'webp' : 'png'
        form.append('input_image_0', new Blob([reference.bytes], { type: reference.type }), `reference.${extension}`)
      }

      const upstream = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${MODEL}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          body: form,
        },
      )
      const raw = await upstream.text()
      if (!upstream.ok) {
        let message = raw
        try {
          const parsed = JSON.parse(raw)
          message = parsed.errors?.map((item: { message?: string }) => item.message).filter(Boolean).join('; ') || parsed.error || raw
        } catch { /* retain upstream response */ }
        return json({ error: message || `Cloudflare returned HTTP ${upstream.status}.` }, upstream.status, headers)
      }

      const result = JSON.parse(raw)
      const image = result?.result?.image
      if (typeof image !== 'string' || !image.length) return json({ error: 'Cloudflare returned no image data.' }, 502, headers)
      return json({ image }, 200, headers)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Unexpected Worker error.' }, 400, headers)
    }
  },
}
