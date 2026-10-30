// POST /api/draft (Vercel Node.js runtime, Web-standard fetch handler). Logic: ./_lib/draft.ts
import { handleDraft } from './_lib/draft'
import { json } from './_lib/http'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleDraft(request)
    } catch {
      console.error('draft: unexpected error')
      return json(500, { error: 'internal_error' })
    }
  },
}
