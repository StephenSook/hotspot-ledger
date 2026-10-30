// Shapes of the JSON files the pipeline writes to web/public/data/.
// Keep in sync with pipeline/hotspot/cli.py (the pipeline is the source of truth).

export type ItemKind = 'tires' | 'furniture' | 'appliances' | 'bags' | 'construction'

export interface ReturnRate {
  closed: number
  returned: number
  share: number | null
}

export interface Metrics {
  generated_at: string
  window: string
  reports_total_in_city: number
  dumping_reports: number
  dumping_share: number
  yearly: Record<string, number>
  yearly_without_top_account: Record<string, number>
  top_account_share: number
  cells_with_dumping: number
  hotspots: number
  hotspot_report_share: number
  median_close_days: number | null
  p90_close_days: number | null
  photo_share: number
  items: Record<ItemKind, number>
  districts: Record<string, { reports: number; population: number | null }>
  return_rates: Record<'28' | '56' | '84', ReturnRate>
  return_rates_without_top_account: Record<'28' | '56' | '84', ReturnRate>
  capture_recapture: {
    years: string
    top_account_cells: number
    other_cells: number
    both: number
    seen: number
    estimate: number
    ci95: [number, number]
    note: string
  }
  equity: Record<string, {
    reported_cells: number
    flagged_unreported_cells: number
    reported_share: number
    flagged_share: number
  }>
}

export interface OwnerHint {
  owner: 'gdot' | 'confirm'
  label: string
  distance_m?: number
}

export interface Cell {
  id: string
  lat: number
  lng: number
  cell_lat: number
  cell_lng: number
  street: string
  n: number
  n_others: number
  hotspot: boolean
  years: Record<string, number>
  years_others: Record<string, number>
  items: Record<ItemKind, number>
  first: string
  last: string
  last_12_months: number
  photos: number
  district: string | null
  plus_code: string
  risk: number
  owner_hint: OwnerHint
  context: {
    dead_ends_within_250: number
    d_major_m: number
    road_m_within_150: number
    streetlight_out_within_300: number
  }
}

export interface RiskCell {
  lat: number
  lng: number
  risk: number
  district: string | null
}

export interface Capture {
  capture30: number
  ci95?: [number, number]
  auc?: number
}

export interface ModelRun {
  runs: Capture[]
  min: number
  max: number
  mean: number
}

export interface ModelEval {
  cells: number
  past_cells: number
  eligible: number
  new_cells: number
  baselines: {
    random: Capture
    dead_ends: Capture
    near_major_road: Capture
    road_density: Capture
    near_old_hotspots: Capture
  }
  models: { map_only: ModelRun; map_plus_old_spots: ModelRun }
  nulls: { runs: number[]; min: number; max: number; mean: number } | null
  train_years: string
  test_year: string
  seeds: number[]
  null_runs: number
  method: string
  without_top_account?: Omit<ModelEval, 'without_top_account' | 'train_years' | 'test_year' | 'seeds' | 'null_runs' | 'method'>
}

export type LngLat = [number, number]

export interface MapLayers {
  city: LngLat[][]
  districts: { district: string; path: LngLat[] }[]
  roads: {
    major: LngLat[][]
    minor: LngLat[][]
    local: LngLat[][]
    service: LngLat[][]
    rail: LngLat[][]
    water: LngLat[][]
  }
}

export interface Meta {
  generated_at: string
  sources: { name: string; license: string; credit?: string }[]
  privacy: string
}

export interface LedgerData {
  metrics: Metrics
  cells: Cell[]
  risk: RiskCell[]
  model: ModelEval
  map: MapLayers
  meta: Meta
}
