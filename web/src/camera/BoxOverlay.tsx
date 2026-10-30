/* Draws the tracked boxes over the visible player at its current time. People are boxes:
   nothing here reads a face or a plate. Redraws from the video's own clock, no React state. */
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { normalizeLabel, type Box, type Group, type Track } from './analysis.ts'

interface Item {
  id: number
  group: Group
  label: string
  box: Box
}

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  times: readonly number[]
  tracks: readonly Track[]
  /** Track ids to draw heavier (the selected cue). */
  highlight: ReadonlySet<number>
}

const STROKE: Record<Group, string> = { vehicle: '#c8c8c8', person: '#4f78a8', object: '#e8271c' }

/** Index of the sample time nearest t, or -1 when t is more than one sample away. */
function nearestIndex(times: readonly number[], t: number): number {
  if (times.length === 0) return -1
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  let best = lo
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) best = lo - 1
  return Math.abs(times[best] - t) <= 0.3 ? best : -1
}

export default function BoxOverlay({ videoRef, times, tracks, highlight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const byTime = useMemo(() => {
    const map = new Map<number, Item[]>()
    for (const tr of tracks) {
      for (const p of tr.points) {
        const list = map.get(p.t) ?? []
        list.push({ id: tr.id, group: tr.group, label: normalizeLabel(tr.label), box: p.box })
        map.set(p.t, list)
      }
    }
    return map
  }, [tracks])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const draw = () => {
      const cw = video.clientWidth
      const ch = video.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh || !cw || !ch) return
      const i = nearestIndex(times, video.currentTime)
      if (i < 0) return
      const items = byTime.get(times[i])
      if (!items) return
      // object-fit: contain
      const scale = Math.min(cw / vw, ch / vh)
      const dw = vw * scale
      const dh = vh * scale
      const ox = (cw - dw) / 2
      const oy = (ch - dh) / 2
      ctx.font = "10px 'Geist Mono', ui-monospace, monospace"
      ctx.textBaseline = 'bottom'
      for (const it of items) {
        const x = ox + it.box.x * dw
        const y = oy + it.box.y * dh
        const w = it.box.w * dw
        const h = it.box.h * dh
        const hot = highlight.has(it.id)
        ctx.strokeStyle = STROKE[it.group]
        ctx.lineWidth = hot ? 2 : 1
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
        const text = `${it.label} ${it.id}`.toUpperCase()
        const tw = ctx.measureText(text).width
        ctx.fillStyle = 'rgba(0,0,0,0.75)'
        ctx.fillRect(Math.round(x), Math.round(y) - 13, tw + 6, 13)
        ctx.fillStyle = STROKE[it.group]
        ctx.fillText(text, Math.round(x) + 3, Math.round(y) - 1)
      }
    }

    const loop = () => {
      draw()
      raf = video.paused || video.ended ? 0 : requestAnimationFrame(loop)
    }
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(loop)
    }
    const events = ['timeupdate', 'seeked', 'loadeddata', 'pause'] as const
    events.forEach((e) => video.addEventListener(e, draw))
    video.addEventListener('play', onPlay)
    const ro = new ResizeObserver(draw)
    ro.observe(video)
    draw()
    if (!video.paused) onPlay()
    return () => {
      cancelAnimationFrame(raf)
      events.forEach((e) => video.removeEventListener(e, draw))
      video.removeEventListener('play', onPlay)
      ro.disconnect()
    }
  }, [byTime, highlight, times, videoRef])

  return <canvas ref={canvasRef} className="cam-overlay" aria-hidden="true" />
}
