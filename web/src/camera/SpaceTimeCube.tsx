/* The space-time cube. The video frame lies flat at the bottom, time rises. Each track is a tube:
   a parked car or a dumped object is a straight pillar, a walking person is a slanted line. */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { OrbitView, type Color, type OrbitViewState, type PickingInfo, type Position } from '@deck.gl/core'
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { center, formatClock, type CueEvent, type Group, type Track } from './analysis.ts'

const GROUP_COLOR: Record<Group, Color> = {
  vehicle: [200, 200, 200, 255], // --text
  person: [79, 120, 168, 255],
  object: [232, 39, 28, 255], // --red
}
const LINE: Color = [61, 61, 61, 255] // --line-strong
const LINE_SOFT: Color = [42, 42, 42, 255] // --line
const LABEL: Color = [122, 122, 122, 255] // --label
const RED: Color = [232, 39, 28, 255]
const RED_DIM: Color = [232, 39, 28, 110]
const FONT = "'Geist Mono', ui-monospace, 'SF Mono', monospace"

/** World units: the frame is 100 wide, the full analyzed time is 100 tall. */
const W = 100
const Z_TOP = 100

const VIEW = new OrbitView({ id: 'cube', orbitAxis: 'Z', fovy: 40 })

export type CubePreset = 'default' | 'top' | 'side'

interface Props {
  aspect: number
  seconds: number
  tracks: readonly Track[]
  events: readonly CueEvent[]
  currentTime: number
  selected: CueEvent | null
  onSeek: (t: number) => void
  onSelectEvent: (e: CueEvent) => void
}

interface Segment {
  from: Position
  to: Position
  color: Color
}

interface Tick {
  position: Position
  text: string
  color: Color
}

function presetState(preset: CubePreset, zoom: number): OrbitViewState {
  const target: [number, number, number] = [0, 0, Z_TOP / 2]
  const base = { target, zoom, minZoom: zoom - 2, maxZoom: zoom + 4 }
  if (preset === 'top') return { ...base, rotationX: 89.9, rotationOrbit: 0 }
  if (preset === 'side') return { ...base, rotationX: 0, rotationOrbit: 0 }
  return { ...base, rotationX: 28, rotationOrbit: -35 }
}

function fitZoom(el: HTMLElement | null): number {
  const rect = el?.getBoundingClientRect()
  const size = rect ? Math.min(rect.width, rect.height) : 400
  // The cube's on-screen footprint, perspective included, is about 1.85 frame widths across in
  // the default view; this keeps the near floor corner and its 0:00 label inside the canvas.
  return Math.log2(Math.max(size, 160) / (W * 1.85))
}

function tickStep(seconds: number): number {
  if (seconds <= 12) return 2
  if (seconds <= 30) return 5
  if (seconds <= 60) return 10
  return 15
}

function relatedTrackIds(e: CueEvent | null): Set<number> {
  const ids = new Set<number>()
  if (!e) return ids
  ids.add(e.objectTrackId)
  if (e.vehicleTrackId !== null) ids.add(e.vehicleTrackId)
  e.personTrackIds.forEach((id) => ids.add(id))
  return ids
}

const tooltipStyle: Partial<CSSStyleDeclaration> = {
  background: 'var(--bg, #000)',
  color: 'var(--text, #c8c8c8)',
  border: '1px solid var(--line-strong, #3d3d3d)',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: '11px',
  letterSpacing: 'var(--track, -0.04em)',
  textTransform: 'uppercase',
  padding: '6px 8px',
  whiteSpace: 'pre',
  lineHeight: '1.5',
}

function SpaceTimeCube({ aspect, seconds, tracks, events, currentTime, selected, onSeek, onSelectEvent }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [viewState, setViewState] = useState<OrbitViewState>(() => presetState('default', 1))
  const [glError, setGlError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const z = fitZoom(wrapRef.current)
    setZoom(z)
    setViewState(presetState('default', z))
  }, [])

  const H = W * aspect
  const zScale = Z_TOP / Math.max(seconds, 1)
  const toWorld = useCallback(
    (cx: number, cy: number, t: number): Position => [(cx - 0.5) * W, (0.5 - cy) * H, t * zScale],
    [H, zScale],
  )

  const frameLayers = useMemo(() => {
    const x0 = -W / 2
    const x1 = W / 2
    const y0 = -H / 2
    const y1 = H / 2
    const corners: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]
    const edges: Segment[] = []
    corners.forEach(([x, y], i) => {
      const [nx, ny] = corners[(i + 1) % 4]
      edges.push({ from: [x, y, 0], to: [x, y, Z_TOP], color: LINE_SOFT })
      edges.push({ from: [x, y, Z_TOP], to: [nx, ny, Z_TOP], color: LINE_SOFT })
    })
    // A light grid on the floor, in thirds, so positions on the frame read at a glance.
    for (let k = 1; k < 3; k++) {
      const gx = x0 + (W * k) / 3
      const gy = y0 + (H * k) / 3
      edges.push({ from: [gx, y0, 0], to: [gx, y1, 0], color: LINE_SOFT })
      edges.push({ from: [x0, gy, 0], to: [x1, gy, 0], color: LINE_SOFT })
    }
    const step = tickStep(seconds)
    const ticks: Tick[] = []
    for (let t = 0; t <= seconds + 1e-6; t += step) {
      const z = t * zScale
      edges.push({ from: [x1, y0, z], to: [x1 + 2.5, y0, z], color: LINE })
      ticks.push({ position: [x1 + 4, y0, z], text: formatClock(t), color: LABEL })
    }
    ticks.push({ position: [x1 + 4, y0, Z_TOP + 7], text: 'TIME', color: LABEL })
    ticks.push({ position: [x0, y0 - 6, 0], text: 'FRAME', color: LABEL })

    return [
      new PolygonLayer<{ polygon: Position[] }>({
        id: 'floor',
        data: [{ polygon: corners.map(([x, y]) => [x, y, 0] as Position) }],
        getPolygon: (d) => d.polygon,
        filled: true,
        getFillColor: [200, 200, 200, 12],
        stroked: true,
        getLineColor: LINE,
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
      }),
      new LineLayer<Segment>({
        id: 'edges',
        data: edges,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => d.color,
        getWidth: 1,
        widthUnits: 'pixels',
      }),
      new TextLayer<Tick>({
        id: 'ticks',
        data: ticks,
        getPosition: (d) => d.position,
        getText: (d) => d.text,
        getColor: (d) => d.color,
        getSize: 10,
        sizeUnits: 'pixels',
        fontFamily: FONT,
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        // Labels sit on the floor plane; draw them on top so the fill never hides 0:00.
        parameters: { depthCompare: 'always' },
      }),
    ]
  }, [H, seconds, zScale])

  const related = useMemo(() => relatedTrackIds(selected), [selected])

  const dataLayers = useMemo(() => {
    const drops: Segment[] = events.map((e) => {
      const top = toWorld(e.cx, e.cy, e.onset)
      return { from: [top[0], top[1], 0], to: top, color: RED_DIM }
    })
    return [
      new PathLayer<Track>({
        id: 'tracks',
        data: tracks as Track[],
        getPath: (tr) =>
          tr.points.map((p) => {
            const c = center(p.box)
            return toWorld(c.cx, c.cy, p.t)
          }),
        getColor: (tr) => {
          const [r, g, b] = GROUP_COLOR[tr.group]
          return [r, g, b, related.size === 0 || related.has(tr.id) ? 255 : 70]
        },
        getWidth: (tr) => (related.has(tr.id) ? 4 : tr.group === 'object' ? 3 : 2),
        widthUnits: 'pixels',
        billboard: true,
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 220],
        updateTriggers: { getColor: [related], getWidth: [related] },
      }),
      new LineLayer<Segment>({
        id: 'event-drops',
        data: drops,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => d.color,
        getWidth: 1,
        widthUnits: 'pixels',
      }),
      new ScatterplotLayer<CueEvent>({
        id: 'events',
        data: events as CueEvent[],
        getPosition: (e) => toWorld(e.cx, e.cy, e.onset),
        getRadius: (e) => (selected?.id === e.id ? 9 : 7),
        radiusUnits: 'pixels',
        filled: true,
        getFillColor: (e) => (e.kind === 'left-behind' ? RED : [0, 0, 0, 255]),
        stroked: true,
        getLineColor: RED,
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        billboard: true,
        pickable: true,
        updateTriggers: { getRadius: [selected?.id] },
      }),
    ]
  }, [events, related, selected, toWorld, tracks])

  const nowLayer = useMemo(() => {
    const z = Math.min(Math.max(currentTime, 0), seconds) * zScale
    const path: Position[] = [
      [-W / 2, -H / 2, z],
      [W / 2, -H / 2, z],
      [W / 2, H / 2, z],
      [-W / 2, H / 2, z],
      [-W / 2, -H / 2, z],
    ]
    return new PathLayer<{ path: Position[] }>({
      id: 'now',
      data: [{ path }],
      getPath: (d) => d.path,
      getColor: [255, 255, 255, 120],
      getWidth: 1,
      widthUnits: 'pixels',
    })
  }, [H, currentTime, seconds, zScale])

  const getTooltip = useCallback((info: PickingInfo) => {
    if (!info.object || !info.layer) return null
    if (info.layer.id === 'tracks') {
      const tr = info.object as Track
      return {
        text: `${tr.label} #${tr.id}\n${tr.group}\n${formatClock(tr.start)} to ${formatClock(tr.end)}`,
        style: tooltipStyle,
      }
    }
    if (info.layer.id === 'events') {
      const e = info.object as CueEvent
      const kind = e.kind === 'left-behind' ? 'Left behind' : 'Appeared, stayed'
      return { text: `${kind}\n${e.objectLabel} #${e.objectTrackId}\nat ${formatClock(e.onset)}`, style: tooltipStyle }
    }
    return null
  }, [])

  const onClick = useCallback(
    (info: PickingInfo) => {
      if (!info.object || !info.layer) return
      if (info.layer.id === 'tracks') onSeek((info.object as Track).start)
      else if (info.layer.id === 'events') onSelectEvent(info.object as CueEvent)
    },
    [onSeek, onSelectEvent],
  )

  const label = `Space-time cube of ${tracks.length} tracks over ${formatClock(seconds)}. The frame is the floor and time rises. ${events.length} cue${events.length === 1 ? '' : 's'} marked.`

  return (
    <div className="cam-cube-block">
      <div className="cam-cube" ref={wrapRef} role="img" aria-label={label}>
        {glError ? (
          <p className="cam-cube-msg">The 3D view needs WebGL, which is off in this browser. The cues list still works.</p>
        ) : (
          <DeckGL
            views={VIEW}
            viewState={viewState}
            onViewStateChange={(p) => setViewState(p.viewState as OrbitViewState)}
            controller={{ inertia: false }}
            layers={[...frameLayers, nowLayer, ...dataLayers]}
            getTooltip={getTooltip}
            onClick={onClick}
            onError={(err) => setGlError(err.message)}
            pickingRadius={6}
          />
        )}
      </div>
      <div className="cam-cube-bar">
        <ul className="cam-legend" aria-label="Legend">
          <li><i className="cam-swatch cam-swatch--vehicle" aria-hidden="true" />Vehicle</li>
          <li><i className="cam-swatch cam-swatch--person" aria-hidden="true" />Person</li>
          <li><i className="cam-swatch cam-swatch--object" aria-hidden="true" />Object</li>
          <li><i className="cam-swatch cam-swatch--cue" aria-hidden="true" />Cue</li>
        </ul>
        <div className="cam-btn-row" role="group" aria-label="Cube view">
          <button type="button" className="cam-btn cam-btn--small" onClick={() => setViewState(presetState('default', zoom))}>
            Reset view
          </button>
          <button type="button" className="cam-btn cam-btn--small" onClick={() => setViewState(presetState('top', zoom))}>
            Top
          </button>
          <button type="button" className="cam-btn cam-btn--small" onClick={() => setViewState(presetState('side', zoom))}>
            Side
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(SpaceTimeCube)
