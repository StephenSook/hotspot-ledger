import { useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { FlyToInterpolator, type MapViewState, type PickingInfo } from '@deck.gl/core'
import { ColumnLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Cell, LngLat, MapLayers, RiskCell } from '../data/types'
import { cellCount } from '../lib/cells'

type RGBA = [number, number, number, number]
const RED: RGBA = [232, 39, 28, 235]
const WHITE: RGBA = [255, 255, 255, 255]

export type MapMode = 'ledger' | 'next' | 'plan'

export interface LedgerMapProps {
  map: MapLayers
  cells: Cell[]
  risk?: RiskCell[]
  mode: MapMode
  hideTop?: boolean
  throughYear?: number
  selectedId?: string | null
  highlightIds?: string[]
  route?: LngLat[]
  onSelect?: (c: Cell | null) => void
  pitch?: number
}

function center(map: MapLayers): [number, number] {
  let minX = 180, minY = 90, maxX = -180, maxY = -90
  for (const ring of map.city) for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}


export default function LedgerMap(props: LedgerMapProps) {
  const { map, cells, risk = [], mode, hideTop = false, throughYear, selectedId, highlightIds = [], route, onSelect, pitch = 52 } = props
  const [lng, lat] = useMemo(() => center(map), [map])
  const [viewState, setViewState] = useState<MapViewState>({ longitude: lng, latitude: lat - 0.012, zoom: 12.35, pitch, bearing: -14 })
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)

  const selected = cells.find((c) => c.id === selectedId) || null
  const highlight = useMemo(() => new Set(highlightIds), [highlightIds])

  const base = useMemo(() => {
    const line = (id: string, data: LngLat[][], color: RGBA, width: number) =>
      new PathLayer<LngLat[]>({ id, data, getPath: (d) => d, getColor: color, getWidth: width, widthUnits: 'pixels', widthMinPixels: width, capRounded: true, jointRounded: true })
    return [
      line('water', map.roads.water, [38, 58, 74, 255], 1),
      line('service', map.roads.service, [24, 24, 24, 255], 0.6),
      line('local', map.roads.local, [36, 36, 36, 255], 0.8),
      line('minor', map.roads.minor, [62, 62, 62, 255], 1),
      line('major', map.roads.major, [104, 104, 104, 255], 1.6),
      line('rail', map.roads.rail, [84, 70, 70, 255], 1),
      new PathLayer<{ district: string; path: LngLat[] }>({
        id: 'districts', data: map.districts, getPath: (d) => d.path, getColor: [70, 70, 70, 255], getWidth: 1, widthUnits: 'pixels',
      }),
      line('city', map.city, [200, 200, 200, 255], 1.6),
    ]
  }, [map])

  const dynamic = useMemo(() => {
    const out = []
    const counted = cells.map((c) => ({ c, v: cellCount(c, hideTop, throughYear) }))
    if (mode === 'ledger' || mode === 'plan') {
      out.push(new ScatterplotLayer<{ c: Cell; v: number }>({
        id: 'minor-cells', data: counted.filter((d) => d.v > 0 && d.v < 3),
        getPosition: (d) => [d.c.lng, d.c.lat], getRadius: 34, radiusUnits: 'meters', getFillColor: [150, 150, 150, 160],
        pickable: true,
      }))
      out.push(new ColumnLayer<{ c: Cell; v: number }>({
        id: 'hotspots', data: counted.filter((d) => d.v >= 3),
        diskResolution: 6, radius: 52, extruded: true, elevationScale: 24,
        getPosition: (d) => [d.c.lng, d.c.lat],
        getElevation: (d) => d.v,
        getFillColor: (d) => (highlight.size && !highlight.has(d.c.id) ? [90, 90, 90, 200] : d.c.id === selectedId ? WHITE : RED),
        pickable: true,
        updateTriggers: { getFillColor: [selectedId, highlightIds.join(',')], getElevation: [hideTop, throughYear] },
        transitions: { getElevation: { duration: 700 } },
      }))
    }
    if (mode === 'next') {
      const max = Math.max(...risk.map((r) => r.risk), 0.0001)
      out.push(new ScatterplotLayer<Cell>({
        id: 'past', data: cells, getPosition: (d) => [d.lng, d.lat], getRadius: 30, radiusUnits: 'meters', getFillColor: [120, 120, 120, 150], pickable: true,
      }))
      out.push(new ScatterplotLayer<RiskCell>({
        id: 'risk', data: risk, getPosition: (d) => [d.lng, d.lat],
        getRadius: (d) => 18 + 52 * (d.risk / max), radiusUnits: 'meters',
        getFillColor: (d) => [232, 39, 28, Math.round(70 + 150 * (d.risk / max))], pickable: true,
      }))
    }
    if (mode === 'plan') {
      out.push(new ScatterplotLayer<Cell>({
        id: 'plan-rings', data: cells.filter((c) => highlight.has(c.id)),
        getPosition: (d) => [d.lng, d.lat], getRadius: 110, radiusUnits: 'meters', stroked: true, filled: false,
        getLineColor: [255, 255, 255, 230], getLineWidth: 1.5, lineWidthUnits: 'pixels',
      }))
      if (route && route.length > 1) {
        out.push(new PathLayer<LngLat[]>({ id: 'route', data: [route], getPath: (d) => d, getColor: [255, 255, 255, 255], getWidth: 2, widthUnits: 'pixels' }))
      }
    }
    return out
  }, [cells, risk, mode, hideTop, throughYear, selectedId, highlight, highlightIds, route])

  function describe(info: PickingInfo): string | null {
    const o = info.object as { c?: Cell; v?: number; risk?: number; district?: string | null; n?: number; street?: string } | undefined
    if (!o) return null
    if (o.c) return `${o.c.street || 'Unnamed spot'} / ${o.v} reports / ${o.c.plus_code}`
    if (typeof o.risk === 'number' && o.n === undefined) return `Likely next / risk ${o.risk.toFixed(2)} / district ${o.district ?? 'n/a'}`
    if (typeof o.n === 'number') return `${o.street || 'Unnamed spot'} / ${o.n} reports`
    return null
  }

  return (
    <div className="mapwrap" role="img" aria-label="3D map of illegal-dumping reports in Mableton, Georgia">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: v }) => setViewState(v as MapViewState)}
        controller={{ dragRotate: true, touchRotate: true }}
        layers={[...base, ...dynamic]}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'crosshair')}
        onHover={(info) => {
          if (info.coordinate) setCursor([info.coordinate[0], info.coordinate[1]])
          const text = describe(info)
          setHover(text ? { x: info.x, y: info.y, text } : null)
        }}
        onClick={(info) => {
          const o = info.object as { c?: Cell } | Cell | undefined
          const cell = o && 'c' in o && o.c ? o.c : o && 'plus_code' in o ? (o as Cell) : null
          onSelect?.(cell)
          if (cell) {
            setViewState((v) => ({ ...v, longitude: cell.lng, latitude: cell.lat - 0.004, zoom: Math.max(v.zoom, 14.2), transitionDuration: 900, transitionInterpolator: new FlyToInterpolator() }))
          }
        }}
      />
      {hover && <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>}
      <div className="cursor-readout lbl" aria-hidden="true">
        {cursor ? `Lat ${cursor[1].toFixed(4)} / Lng ${cursor[0].toFixed(4)}` : 'Lat -- / Lng --'}
        {selected && <span className="white">{`  //  ${selected.plus_code}`}</span>}
      </div>
    </div>
  )
}
