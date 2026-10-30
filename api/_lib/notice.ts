// Shared by the API (api/_lib/draft.ts, api/_lib/sign.ts) and the web app (verify and print pages).
// Pure TypeScript with no Node or DOM imports beyond the Web Crypto global, so the server that signs a
// notice and the browser that checks it render the exact same English and Spanish text.

export const ITEM_KINDS = ['tires', 'furniture', 'appliances', 'bags', 'construction'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]
// The planner's treatment codes (web/src/lib/plan.ts). The client sends the code, never a sentence.
export const TREATMENTS = ['close_access', 'sign_qr', 'bulk_outreach', 'tire_play', 'commercial_check', 'cleanup', 'camera'] as const
export type Treatment = (typeof TREATMENTS)[number]
export const OWNERS = ['city', 'cobb', 'gdot', 'private', 'confirm'] as const
export type Owner = (typeof OWNERS)[number]

export interface Spot {
  plus_code: string
  district: string | null
  items: Record<ItemKind, number>
  n: number
  /** Reports in the last 12 months. A count, never a date: no published field dates one report. */
  recent: number
  treatment: Treatment
  owner_label: Owner
}

// Full Open Location Code as the pipeline writes it (olc.encode(lat, lng, 10) gives 8 + 2).
export const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$/
export const DISTRICT = /^[1-6]$/

/** One sentence in both languages. The team wrote and translated every sentence; code fills numbers. */
export interface Bilingual {
  en: string
  es: string
}

/** What the city is doing at the spot, one fixed sentence per planner treatment code. */
export const ACTION: Record<Treatment, Bilingual> = {
  close_access: {
    en: 'The city plans to close off easy vehicle access to this spot.',
    es: 'La ciudad planea cerrar el acceso fácil de vehículos a este lugar.',
  },
  sign_qr: {
    en: 'The city is putting up a sign with a QR code so anyone can report dumping here.',
    es: 'La ciudad va a poner un letrero con un código QR para que cualquier persona pueda reportar basura tirada aquí.',
  },
  bulk_outreach: {
    en: 'The city is sharing how bulk-item pickup works, in English and Spanish.',
    es: 'La ciudad está explicando cómo funciona la recogida de objetos grandes, en inglés y en español.',
  },
  tire_play: {
    en: 'The city is promoting tire amnesty so old tires have a proper place to go.',
    es: 'La ciudad está promoviendo la amnistía de llantas para que las llantas viejas tengan un lugar adecuado.',
  },
  commercial_check: {
    en: 'The city is looking into where the dumped materials come from, including work and business waste.',
    es: 'La ciudad está investigando de dónde vienen los materiales tirados, incluidos los desechos de obras y negocios.',
  },
  cleanup: { en: 'A city crew will clean up this spot.', es: 'Un equipo de la ciudad va a limpiar este lugar.' },
  camera: {
    en: 'The city may place a camera at this spot to discourage dumping.',
    es: 'La ciudad podría poner una cámara en este lugar para evitar que se tire basura.',
  },
}

/**
 * Which disposal tips belong in the notice. A group "dominates" when its count is the largest of
 * bulk items (furniture + appliances), tires, bags and construction debris. Ties include both tips.
 */
export function pickTips(items: Record<ItemKind, number>): { bulkPickup: boolean; tireAmnesty: boolean } {
  const bulk = items.furniture + items.appliances
  const top = Math.max(bulk, items.tires, items.bags, items.construction)
  if (top === 0) return { bulkPickup: false, tireAmnesty: false }
  return { bulkPickup: bulk === top, tireAmnesty: items.tires === top }
}

/*
 * Gemini chooses, code writes. The model never writes a word of the notice: it picks which of the
 * sentences below to use and in what order, and this file renders them in English and Spanish with
 * every number taken from the request. A notice therefore cannot contain an invented name, address,
 * date or number, whatever the model returns. A staff member still approves every draft.
 */
export const SENTENCE_IDS = [
  'where', 'total', 'recent', 'tires', 'bulky', 'bags', 'construction', 'action', 'tip_bulk', 'tip_tires', 'no_blame', 'how_to_report',
] as const
export type SentenceId = (typeof SENTENCE_IDS)[number]
const REQUIRED: readonly SentenceId[] = ['where', 'action', 'how_to_report']
const MAX_OPTIONAL = 5
export const OPENING: Bilingual = { en: 'Thank you, neighbors.', es: 'Gracias, vecinos.' }
export const CLOSING: Bilingual = {
  en: 'Thank you for helping keep this area clean.',
  es: 'Gracias por ayudar a mantener limpia esta zona.',
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The sentences this spot can use. A sentence whose fact is zero, or a tip that does not apply, is absent. */
export function sentenceBank(s: Spot): Partial<Record<SentenceId, Bilingual>> {
  const tips = pickTips(s.items)
  const bank: Partial<Record<SentenceId, Bilingual>> = {
    where: {
      en: `Dumping keeps coming back at Plus Code ${s.plus_code}${s.district ? `, in council district ${s.district}` : ''}.`,
      es: `La basura tirada sigue apareciendo en el Plus Code ${s.plus_code}${s.district ? `, en el distrito ${s.district}` : ''}.`,
    },
    total: {
      // Names its subject: the model may place it after a tip, where "it" would mean the pickup.
      en: `Dumping at this spot has been reported ${s.n} ${plural(s.n, 'time', 'times')} since 2021.`,
      es: `La basura tirada en este lugar se ha reportado ${s.n} ${plural(s.n, 'vez', 'veces')} desde 2021.`,
    },
    action: ACTION[s.treatment],
    no_blame: {
      en: 'We are not blaming anyone. Most neighbors want this spot clean too.',
      es: 'No estamos culpando a nadie. La mayoría de los vecinos también quiere este lugar limpio.',
    },
    how_to_report: {
      en: 'To report dumping, scan the QR code on the city sign at this spot or report it on the City of Mableton website.',
      es: 'Para reportar basura tirada, escanee el código QR del letrero de la ciudad en este lugar o repórtela en el sitio web de la Ciudad de Mableton.',
    },
  }
  if (s.recent > 0) {
    bank.recent = {
      // Self-contained: the model may place it after any sentence, so it must not say "those".
      en: `${s.recent} ${plural(s.recent, 'report was', 'reports were')} made in the last 12 months.`,
      es: `Se ${plural(s.recent, 'hizo', 'hicieron')} ${s.recent} ${plural(s.recent, 'reporte', 'reportes')} en los últimos 12 meses.`,
    }
  }
  const item = (n: number, en: string, es: string): Bilingual => ({
    en: `${n} ${plural(n, 'report mentions', 'reports mention')} ${en}.`,
    es: `${n} ${plural(n, 'reporte menciona', 'reportes mencionan')} ${es}.`,
  })
  if (s.items.tires > 0) bank.tires = item(s.items.tires, 'tires', 'llantas')
  // Furniture and appliances are counted per category, and one report can mention both, so their
  // sum is not a number of reports. Each count is stated on its own.
  const { furniture: f, appliances: a } = s.items
  if (f > 0 && a > 0) {
    bank.bulky = {
      en: `${f} ${plural(f, 'report mentions', 'reports mention')} furniture, and ${a} ${plural(a, 'mentions', 'mention')} appliances.`,
      es: `${f} ${plural(f, 'reporte menciona', 'reportes mencionan')} muebles, y ${a} ${plural(a, 'menciona', 'mencionan')} electrodomésticos.`,
    }
  } else if (f > 0) bank.bulky = item(f, 'furniture', 'muebles')
  else if (a > 0) bank.bulky = item(a, 'appliances', 'electrodomésticos')
  if (s.items.bags > 0) bank.bags = item(s.items.bags, 'bags of trash', 'bolsas de basura')
  if (s.items.construction > 0) bank.construction = item(s.items.construction, 'construction debris', 'escombros de construcción')
  if (tips.bulkPickup) {
    bank.tip_bulk = {
      en: 'Large items like furniture and appliances can go out for bulk-item pickup instead of being left here. The City of Mableton website explains how to schedule it.',
      es: 'Los objetos grandes, como muebles y electrodomésticos, se pueden sacar para la recogida de objetos grandes en vez de dejarlos aquí. El sitio web de la Ciudad de Mableton explica cómo programarla.',
    }
  }
  if (tips.tireAmnesty) {
    bank.tip_tires = {
      en: 'Old tires can go to a tire amnesty event instead of being left here. The City of Mableton website lists the next one.',
      es: 'Las llantas viejas se pueden llevar a un evento de amnistía de llantas en vez de dejarlas aquí. El sitio web de la Ciudad de Mableton anuncia el próximo.',
    }
  }
  return bank
}

/**
 * Renders the notice. Ids this spot cannot use are dropped, repeats are dropped, at most
 * MAX_OPTIONAL optional sentences are kept, and the required sentences are always present:
 * "where" first, "action" right after it, "how_to_report" last.
 */
export function composeNotice(spot: Spot, chosen: readonly SentenceId[]): { en: string; es: string; sentences: SentenceId[] } {
  const bank = sentenceBank(spot)
  const optional: SentenceId[] = []
  for (const id of chosen) {
    if (bank[id] && !REQUIRED.includes(id) && !optional.includes(id) && optional.length < MAX_OPTIONAL) optional.push(id)
  }
  // Keep the model's order for optional sentences that come before the action, and after it.
  const actionAt = chosen.indexOf('action')
  const before = optional.filter((id) => actionAt === -1 || chosen.indexOf(id) < actionAt)
  const after = optional.filter((id) => !before.includes(id))
  const sentences: SentenceId[] = ['where', ...before, 'action', ...after, 'how_to_report']
  const render = (lang: keyof Bilingual) =>
    [OPENING[lang], ...sentences.map((id) => bank[id]![lang]), CLOSING[lang]].join(' ')
  return { en: render('en'), es: render('es'), sentences }
}

/*
 * Signed notices. The city signs a compact payload with an Ed25519 private key that exists only in
 * the server environment (NOTICE_SIGNING_KEY). The QR code on a printed notice carries
 * "<payload>.<signature>"; any browser checks the signature with the public key below and re-renders
 * the exact notice from the payload, so a forged or edited notice cannot pass. The payload holds only
 * codes and counts, never free text.
 */
export const NOTICE_PUBLIC_KEY = 'Git_pm8nClXwkEP-zqnow7I0yN6ywFus2uEaykL4eIM'
export const MAX_TOKEN_CHARS = 1200

export interface NoticePayload {
  v: 1
  /** Plus Code of the spot. */
  p: string
  /** Council district, or null. */
  d: string | null
  t: Treatment
  /** Reports since 2021. */
  n: number
  /** Reports in the last 12 months. */
  r: number
  /** Item counts in ITEM_KINDS order. */
  i: number[]
  /** Sentence indexes into SENTENCE_IDS, in notice order. */
  s: number[]
  /** Issue date, YYYY-MM-DD (UTC). */
  dt: string
}

const PAYLOAD_KEYS = ['v', 'p', 'd', 't', 'n', 'r', 'i', 's', 'dt'] as const
const MAX_COUNT = 10_000

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const isCount = (x: unknown, max = MAX_COUNT): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max

function realDate(text: unknown): text is string {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const d = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text
}

export function payloadFromNotice(spot: Spot, sentences: readonly SentenceId[], date: string): NoticePayload {
  return {
    v: 1,
    p: spot.plus_code,
    d: spot.district,
    t: spot.treatment,
    n: spot.n,
    r: spot.recent,
    i: ITEM_KINDS.map((k) => spot.items[k]),
    s: sentences.map((id) => SENTENCE_IDS.indexOf(id)),
    dt: date,
  }
}

export function encodePayload(payload: NoticePayload): string {
  const ordered = Object.fromEntries(PAYLOAD_KEYS.map((k) => [k, payload[k]]))
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(ordered)))
}

/** Strict decode: exact keys, allow-listed codes, bounded integers. Anything else is null. */
export function decodePayload(text: string): NoticePayload | null {
  const bytes = b64urlDecode(text)
  if (!bytes || bytes.length > 600) return null
  let o: unknown
  try {
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const keys = Object.keys(r)
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((k) => keys.includes(k))) return null
  if (r.v !== 1) return null
  if (typeof r.p !== 'string' || !PLUS_CODE.test(r.p)) return null
  if (r.d !== null && (typeof r.d !== 'string' || !DISTRICT.test(r.d))) return null
  if (typeof r.t !== 'string' || !(TREATMENTS as readonly string[]).includes(r.t)) return null
  if (!isCount(r.n) || !isCount(r.r) || (r.r as number) > (r.n as number)) return null
  if (!Array.isArray(r.i) || r.i.length !== ITEM_KINDS.length || !r.i.every((x) => isCount(x) && (x as number) <= (r.n as number))) return null
  if (!Array.isArray(r.s) || r.s.length < 1 || r.s.length > 20 || !r.s.every((x) => isCount(x, SENTENCE_IDS.length - 1))) return null
  if (!realDate(r.dt)) return null
  return r as unknown as NoticePayload
}

export function spotFromPayload(p: NoticePayload): Spot {
  return {
    plus_code: p.p,
    district: p.d,
    items: Object.fromEntries(ITEM_KINDS.map((k, j) => [k, p.i[j]])) as Record<ItemKind, number>,
    n: p.n,
    recent: p.r,
    treatment: p.t,
    owner_label: 'confirm',
  }
}

export function renderPayload(p: NoticePayload): { en: string; es: string; sentences: SentenceId[] } {
  return composeNotice(spotFromPayload(p), p.s.map((j) => SENTENCE_IDS[j]))
}

export type VerifyResult =
  | { status: 'valid'; payload: NoticePayload; notice: { en: string; es: string; sentences: SentenceId[] } }
  | { status: 'invalid'; reason: 'format' | 'signature' | 'payload' }
  | { status: 'unsupported' }

/** Checks "<payload>.<signature>" against the city's public key with Web Crypto Ed25519. */
export async function verifyNoticeToken(token: string, publicKey: string = NOTICE_PUBLIC_KEY): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return { status: 'invalid', reason: 'format' }
  const parts = token.split('.')
  if (parts.length !== 2) return { status: 'invalid', reason: 'format' }
  const sig = b64urlDecode(parts[1])
  const pub = b64urlDecode(publicKey)
  if (!sig || sig.length !== 64 || !pub || pub.length !== 32 || !b64urlDecode(parts[0])) return { status: 'invalid', reason: 'format' }
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { status: 'unsupported' }
  }
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(parts[0]))
  if (!ok) return { status: 'invalid', reason: 'signature' }
  const payload = decodePayload(parts[0])
  if (!payload) return { status: 'invalid', reason: 'payload' }
  return { status: 'valid', payload, notice: renderPayload(payload) }
}
