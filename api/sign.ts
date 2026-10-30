// POST /api/sign (Vercel Node.js runtime, Web-standard fetch handler). Logic: ./_lib/sign.ts
import { json } from './_lib/http'
import { handleSign } from './_lib/sign'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleSign(request)
    } catch {
      console.error('sign: unexpected error')
      return json(500, { error: 'internal_error' })
    }
  },
}
