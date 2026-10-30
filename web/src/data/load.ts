import type { Cell, LedgerData, MapLayers, Meta, Metrics, ModelEval, RiskCell } from './types'

async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!type.includes('json')) throw new Error(`${name}: expected JSON, got ${type || 'unknown'}`)
  return (await res.json()) as T
}

export async function loadLedger(): Promise<LedgerData> {
  const [metrics, cells, risk, model, map, meta] = await Promise.all([
    getJson<Metrics>('metrics.json'),
    getJson<Cell[]>('cells.json'),
    getJson<RiskCell[]>('risk.json'),
    getJson<ModelEval>('model.json'),
    getJson<MapLayers>('map.json'),
    getJson<Meta>('meta.json'),
  ])
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('cells.json is empty')
  if (!metrics.dumping_reports) throw new Error('metrics.json has no reports')
  return { metrics, cells, risk, model, map, meta }
}
