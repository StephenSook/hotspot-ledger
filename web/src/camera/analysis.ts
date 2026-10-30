/* Pure analysis for the Camera page: label groups, an IoU tracker, and the left-behind rule.
   No DOM and no MediaPipe in this file, so every rule here runs in a unit test.

   Coordinates are normalized to the frame: x and w are fractions of frame width, y and h are
   fractions of frame height, origin at the top-left. Distances that the rules compare against a
   threshold are measured in fractions of FRAME WIDTH, so `aspect` (height / width) converts the
   vertical component. */

export type Group = 'vehicle' | 'person' | 'object'

export const GROUPS: readonly Group[] = ['vehicle', 'person', 'object']

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface RawDetection {
  label: string
  score: number
  box: Box
}

export interface Frame {
  /** Seconds from the start of the clip. */
  t: number
  detections: readonly RawDetection[]
}

export interface TrackPoint {
  t: number
  box: Box
  score: number
}

export interface Track {
  id: number
  group: Group
  /** Most frequent COCO label across the track, weighted by score. */
  label: string
  points: TrackPoint[]
  start: number
  end: number
}

export interface Interval {
  start: number
  end: number
}

/* ---------- Sampling ---------- */

export const SAMPLE_FPS = 4
export const MAX_SECONDS = 90

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** Times (seconds) to sample: the middle of each 1/fps slot, over at most `maxSec` seconds. */
export function sampleTimes(durationSec: number, fps = SAMPLE_FPS, maxSec = MAX_SECONDS): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || fps <= 0) return []
  const span = Math.min(durationSec, maxSec)
  const step = 1 / fps
  const out: number[] = []
  for (let i = 0; ; i++) {
    const t = (i + 0.5) * step
    if (t >= span) break
    out.push(round3(t))
  }
  if (out.length === 0) out.push(round3(span / 2))
  return out
}

/* ---------- Labels ---------- */

const ALIASES: Record<string, string> = {
  sofa: 'couch',
  tvmonitor: 'tv',
  motorbike: 'motorcycle',
  aeroplane: 'airplane',
  diningtable: 'dining table',
  pottedplant: 'potted plant',
}

const PERSON_LABELS = new Set(['person'])
const VEHICLE_LABELS = new Set(['car', 'truck', 'bus', 'motorcycle'])
const ANIMAL_LABELS = new Set([
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe',
])
/** Not people, vehicles or animals, but never dumped: fixed street furniture, and vehicles that do
    not stop at a curb. Dropping them keeps a hydrant that a parked car hides and then reveals from
    reading as a new object. */
const IGNORED_LABELS = new Set([
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'airplane', 'train',
])

export function normalizeLabel(raw: string): string {
  const label = raw.trim().toLowerCase()
  return ALIASES[label] ?? label
}

/** vehicle, person, object, or null for labels the rules ignore (animals, street furniture). */
export function groupForLabel(raw: string): Group | null {
  const label = normalizeLabel(raw)
  if (label === '' || label === '???' || label === 'n/a') return null
  if (PERSON_LABELS.has(label)) return 'person'
  if (VEHICLE_LABELS.has(label)) return 'vehicle'
  if (ANIMAL_LABELS.has(label) || IGNORED_LABELS.has(label)) return null
  return 'object'
}

/* ---------- MediaPipe result to Frame (structural type, so this stays testable) ---------- */

export interface DetectionLike {
  categories: ReadonlyArray<{ categoryName: string; displayName?: string; score: number }>
  boundingBox?: { originX: number; originY: number; width: number; height: number }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Converts pixel boxes from the detector into a normalized Frame. Drops empty boxes. */
export function toFrame(
  t: number,
  detections: readonly DetectionLike[],
  width: number,
  height: number,
): Frame {
  const out: RawDetection[] = []
  if (width <= 0 || height <= 0) return { t, detections: out }
  for (const d of detections) {
    const bb = d.boundingBox
    let top: DetectionLike['categories'][number] | undefined
    for (const c of d.categories) if (!top || c.score > top.score) top = c
    if (!bb || !top) continue
    const x0 = clamp01(bb.originX / width)
    const y0 = clamp01(bb.originY / height)
    const x1 = clamp01((bb.originX + bb.width) / width)
    const y1 = clamp01((bb.originY + bb.height) / height)
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue
    out.push({
      label: normalizeLabel(top.categoryName || top.displayName || ''),
      score: top.score,
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    })
  }
  return { t, detections: out }
}

/* ---------- Geometry ---------- */

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

export function center(b: Box): { cx: number; cy: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 }
}

/** Distance between two normalized points, in frame widths. */
export function distW(ax: number, ay: number, bx: number, by: number, aspect: number): number {
  return Math.hypot(ax - bx, (ay - by) * aspect)
}

/** Distance from a point to the nearest edge of a box (0 when inside), in frame widths. */
export function pointToBoxW(px: number, py: number, b: Box, aspect: number): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w))
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h))
  return Math.hypot(dx, dy * aspect)
}

function diagW(b: Box, aspect: number): number {
  return Math.hypot(b.w, b.h * aspect)
}

function meanBox(points: readonly TrackPoint[]): Box {
  const n = points.length
  let x = 0, y = 0, w = 0, h = 0
  for (const p of points) {
    x += p.box.x
    y += p.box.y
    w += p.box.w
    h += p.box.h
  }
  return { x: x / n, y: y / n, w: w / n, h: h / n }
}

/* ---------- Tracker ---------- */

export interface TrackerConfig {
  /** Frame height / width. */
  aspect: number
  /** IoU at or above this is a confident match. */
  minIou: number
  /** Fallback when IoU is low (fast mover at 4 fps): the center may move this many box
      diagonals between samples, if the box area changed less than 4x. */
  centerGate: number
  /** How long a track may go unseen and still be continued, per group. Objects get longer
      because the person or vehicle that drops them often hides them for a few seconds. */
  maxGapSec: Record<Group, number>
}

export const DEFAULT_TRACKER: Omit<TrackerConfig, 'aspect'> = {
  minIou: 0.3,
  centerGate: 0.75,
  maxGapSec: { vehicle: 1.5, person: 1.5, object: 8 },
}

/** Match score between a track's last box and a new detection. 0 means no match.
    IoU matches score above 1, center-distance fallbacks score below 1, so IoU always wins. */
export function matchScore(prev: Box, next: Box, cfg: Pick<TrackerConfig, 'aspect' | 'minIou' | 'centerGate'>): number {
  const o = iou(prev, next)
  if (o >= cfg.minIou) return 1 + o
  const prevArea = Math.max(prev.w * prev.h, 1e-9)
  const ratio = (next.w * next.h) / prevArea
  if (ratio < 0.25 || ratio > 4) return 0
  const a = center(prev)
  const b = center(next)
  const d = distW(a.cx, a.cy, b.cx, b.cy, cfg.aspect)
  const gate = cfg.centerGate * Math.max(diagW(prev, cfg.aspect), diagW(next, cfg.aspect))
  if (gate <= 0 || d >= gate) return 0
  return 1 - d / gate
}

interface LiveTrack {
  id: number
  group: Group
  votes: Map<string, number>
  points: TrackPoint[]
}

export interface Tracker {
  push(frame: Frame): void
  /** Tracks with at least `minPoints` points, in id order. */
  tracks(minPoints?: number): Track[]
  /** Count of tracks with at least 2 points, per group. */
  counts(): Record<Group, number>
}

function bestLabel(votes: Map<string, number>): string {
  let best = ''
  let bestScore = -1
  for (const [label, score] of votes) {
    if (score > bestScore) {
      best = label
      bestScore = score
    }
  }
  return best
}

/** Greedy IoU tracker. Detections only match tracks of the same group, and a track keeps the
    label it was seen with most often (car and truck swap often on the same vehicle). */
export function createTracker(config: Partial<Omit<TrackerConfig, 'aspect'>> & { aspect: number }): Tracker {
  const cfg: TrackerConfig = {
    ...DEFAULT_TRACKER,
    ...config,
    maxGapSec: { ...DEFAULT_TRACKER.maxGapSec, ...config.maxGapSec },
  }
  const live: LiveTrack[] = []
  let nextId = 1
  let lastT = -Infinity

  function push(frame: Frame): void {
    if (frame.t <= lastT) return
    lastT = frame.t
    const byGroup = new Map<Group, RawDetection[]>()
    for (const det of frame.detections) {
      const g = groupForLabel(det.label)
      if (!g) continue
      const list = byGroup.get(g)
      if (list) list.push(det)
      else byGroup.set(g, [det])
    }
    for (const [group, dets] of byGroup) {
      const active = live.filter((tr) => {
        if (tr.group !== group) return false
        const last = tr.points[tr.points.length - 1]
        return frame.t - last.t <= cfg.maxGapSec[group]
      })
      const pairs: { ti: number; di: number; s: number }[] = []
      active.forEach((tr, ti) => {
        const last = tr.points[tr.points.length - 1].box
        dets.forEach((d, di) => {
          const s = matchScore(last, d.box, cfg)
          if (s > 0) pairs.push({ ti, di, s })
        })
      })
      pairs.sort((a, b) => b.s - a.s)
      const usedT = new Set<number>()
      const usedD = new Set<number>()
      for (const p of pairs) {
        if (usedT.has(p.ti) || usedD.has(p.di)) continue
        usedT.add(p.ti)
        usedD.add(p.di)
        append(active[p.ti], dets[p.di], frame.t)
      }
      dets.forEach((d, di) => {
        if (usedD.has(di)) return
        const tr: LiveTrack = { id: nextId++, group, votes: new Map(), points: [] }
        append(tr, d, frame.t)
        live.push(tr)
      })
    }
  }

  function append(tr: LiveTrack, d: RawDetection, t: number): void {
    tr.points.push({ t, box: d.box, score: d.score })
    const label = normalizeLabel(d.label)
    tr.votes.set(label, (tr.votes.get(label) ?? 0) + d.score)
  }

  function tracks(minPoints = 2): Track[] {
    return live
      .filter((tr) => tr.points.length >= minPoints)
      .map((tr) => ({
        id: tr.id,
        group: tr.group,
        label: bestLabel(tr.votes),
        points: tr.points.slice(),
        start: tr.points[0].t,
        end: tr.points[tr.points.length - 1].t,
      }))
  }

  function counts(): Record<Group, number> {
    const c: Record<Group, number> = { vehicle: 0, person: 0, object: 0 }
    for (const tr of live) if (tr.points.length >= 2) c[tr.group]++
    return c
  }

  return { push, tracks, counts }
}

export function trackFrames(frames: readonly Frame[], aspect: number, config: Partial<Omit<TrackerConfig, 'aspect'>> = {}): Track[] {
  const tracker = createTracker({ ...config, aspect })
  for (const f of frames) tracker.push(f)
  return tracker.tracks()
}

/* ---------- Stillness ---------- */

/** Periods of at least `minSec` where the box center stays within about `maxMove` frame widths.
    The track is cut into runs whose points stay within `maxMove` of the run's first point, then
    neighboring runs merge when their mean centers agree within `maxMove / 2` and the gap between
    them is at most `mergeGapSec`. Merging stops a stop from splitting in two when a run starts on
    the last moving point, or when a person briefly blocks the vehicle and shifts its box. */
export function stationaryIntervals(
  points: readonly TrackPoint[],
  maxMove: number,
  minSec: number,
  aspect: number,
  mergeGapSec = 1.5,
): Interval[] {
  const runs: { start: number; end: number; cx: number; cy: number }[] = []
  let i = 0
  while (i < points.length) {
    const a = center(points[i].box)
    let j = i
    while (j + 1 < points.length) {
      const b = center(points[j + 1].box)
      if (distW(a.cx, a.cy, b.cx, b.cy, aspect) > maxMove) break
      j++
    }
    let sx = 0
    let sy = 0
    for (let k = i; k <= j; k++) {
      const c = center(points[k].box)
      sx += c.cx
      sy += c.cy
    }
    const n = j - i + 1
    runs.push({ start: points[i].t, end: points[j].t, cx: sx / n, cy: sy / n })
    i = j + 1
  }
  const merged: typeof runs = []
  for (const r of runs) {
    // Look back over runs that ended within the gap window. A match absorbs the short,
    // displaced runs in between (the frames where something blocked the vehicle).
    let match = -1
    for (let k = merged.length - 1; k >= 0 && r.start - merged[k].end <= mergeGapSec; k--) {
      // Half of maxMove: runs of a parked vehicle agree to within jitter, while a slow drift
      // makes neighboring runs about one maxMove apart and must not chain into a "stop".
      if (distW(merged[k].cx, merged[k].cy, r.cx, r.cy, aspect) <= maxMove / 2) {
        match = k
        break
      }
    }
    if (match >= 0) {
      merged[match].end = r.end
      merged.length = match + 1
    } else {
      merged.push({ ...r })
    }
  }
  return merged.filter((r) => r.end - r.start >= minSec).map(({ start, end }) => ({ start, end }))
}

/** True when every point in [from, to] is within `maxMove` of the first one. Needs one point. */
export function isStillDuring(
  points: readonly TrackPoint[],
  from: number,
  to: number,
  maxMove: number,
  aspect: number,
): boolean {
  const inRange = points.filter((p) => p.t >= from && p.t <= to)
  if (inRange.length === 0) return false
  const a = center(inRange[0].box)
  return inRange.every((p) => {
    const b = center(p.box)
    return distW(a.cx, a.cy, b.cx, b.cy, aspect) <= maxMove
  })
}

/* ---------- Cues ---------- */

export type CueKind = 'left-behind' | 'appeared-stayed'

export interface CueEvent {
  id: string
  kind: CueKind
  confidence: 'higher' | 'lower'
  /** Seconds: when the object was first seen. */
  onset: number
  objectTrackId: number
  objectLabel: string
  /** Normalized center of the object where it first appeared. */
  cx: number
  cy: number
  /** How long the object track lasts after it appears. */
  stayedSec: number
  vehicleTrackId: number | null
  vehicleLabel: string | null
  stop: Interval | null
  personTrackIds: number[]
}

export interface RuleConfig {
  aspect: number
  /** First and last sampled times of the clip. */
  clipStart: number
  clipEnd: number
  /** A vehicle is stopped when its center moves less than this many frame widths ... */
  stopMaxMove: number
  /** ... for at least this long. */
  stopMinSec: number
  /** A person counts as getting out (or back in) when their first (or last) point is within
      this many frame widths of the stopped vehicle's box. */
  personNear: number
  /** Allowed slack on the stop window for person start and end times. */
  timeSlackSec: number
  /** The object must first appear within this many frame widths of the stopped vehicle. */
  objectNear: number
  /** The object may first show up to this long after the stop ends: the vehicle often hides it
      until it pulls away. */
  revealSlackSec: number
  /** The object must still be seen this long after the vehicle track ends. */
  outlastSec: number
  /** Movement allowed for an object that "stays". */
  stayMaxMove: number
  /** Simpler cue: an object that appears mid-clip and stays still this long. */
  appearedMinSec: number
  /** "Mid-clip" means first seen at least this long after the clip starts. */
  midClipGraceSec: number
  /** Simpler cue: the still object must be left with no person on it for this long. */
  unattendedMinSec: number
  /** A vehicle track that ends and is replaced in place within this long has not left. */
  reappearSec: number
}

export const DEFAULT_RULES: Omit<RuleConfig, 'aspect' | 'clipStart' | 'clipEnd'> = {
  stopMaxMove: 0.02,
  stopMinSec: 2,
  personNear: 0.12,
  timeSlackSec: 1.5,
  objectNear: 0.25,
  revealSlackSec: 1,
  outlastSec: 2,
  stayMaxMove: 0.03,
  appearedMinSec: 3,
  midClipGraceSec: 1,
  unattendedMinSec: 1,
  reappearSec: 3,
}

const first = (tr: Track): TrackPoint => tr.points[0]
const last = (tr: Track): TrackPoint => tr.points[tr.points.length - 1]

/** A person box (padded) overlaps the object box at time t. */
function attendedAt(t: number, obj: Box, persons: readonly Track[], pad: number): boolean {
  const padded: Box = { x: obj.x - pad, y: obj.y - pad, w: obj.w + 2 * pad, h: obj.h + 2 * pad }
  for (const p of persons) {
    if (t < p.start - 0.2 || t > p.end + 0.2) continue
    for (const pt of p.points) {
      if (Math.abs(pt.t - t) <= 0.2 && iou(padded, pt.box) > 0) return true
    }
  }
  return false
}

/** Longest run, within the interval, of object points with no person on the object. */
function longestUnattendedSec(obj: Track, iv: Interval, persons: readonly Track[]): number {
  let best = 0
  let runStart: number | null = null
  let runEnd = 0
  for (const p of obj.points) {
    if (p.t < iv.start || p.t > iv.end) continue
    if (attendedAt(p.t, p.box, persons, 0.02)) {
      runStart = null
    } else {
      if (runStart === null) runStart = p.t
      runEnd = p.t
      best = Math.max(best, runEnd - runStart)
    }
  }
  return best
}

function vehicleLeft(v: Track, vehicles: readonly Track[], reappearSec: number): boolean {
  const lastBox = last(v).box
  return !vehicles.some(
    (o) => o.id !== v.id && o.start > v.end && o.start - v.end <= reappearSec && iou(first(o).box, lastBox) >= 0.3,
  )
}

/** Finds the left-behind signature and the simpler appeared-and-stayed cue.
    Left-behind (higher confidence), all of:
      1. a vehicle track is stopped (center moves < stopMaxMove for >= stopMinSec);
      2. a person track starts near that vehicle during the stop, and a person track ends near it
         during the stop (often the same track; two tracks when the person was briefly hidden);
      3. an object track first appears during the stop (or within revealSlackSec after it),
         within objectNear of the vehicle;
      4. the vehicle leaves, and the object is still seen, and still, outlastSec after that.
    Appeared-stayed (lower confidence): an object first seen mid-clip that stays still for
    appearedMinSec, with at least unattendedMinSec of that time with no person on it. */
export function detectCues(
  tracks: readonly Track[],
  config: Partial<Omit<RuleConfig, 'aspect' | 'clipStart' | 'clipEnd'>> & Pick<RuleConfig, 'aspect' | 'clipStart' | 'clipEnd'>,
): CueEvent[] {
  const cfg: RuleConfig = { ...DEFAULT_RULES, ...config }
  const usable = tracks.filter((t) => t.points.length >= 2)
  const vehicles = usable.filter((t) => t.group === 'vehicle')
  const persons = usable.filter((t) => t.group === 'person')
  const objects = usable.filter((t) => t.group === 'object')
  const events: CueEvent[] = []
  const flagged = new Set<number>()
  const { aspect } = cfg

  for (const v of vehicles) {
    if (!vehicleLeft(v, vehicles, cfg.reappearSec)) continue
    for (const stop of stationaryIntervals(v.points, cfg.stopMaxMove, cfg.stopMinSec, aspect)) {
      const vbox = meanBox(v.points.filter((p) => p.t >= stop.start && p.t <= stop.end))
      const lo = stop.start - cfg.timeSlackSec
      const hi = stop.end + cfg.timeSlackSec
      const nearVehicle = (p: TrackPoint): boolean => {
        const c = center(p.box)
        return pointToBoxW(c.cx, c.cy, vbox, aspect) <= cfg.personNear
      }
      const outs = persons.filter((p) => p.start >= lo && p.start <= hi && nearVehicle(first(p)))
      const ins = persons.filter((p) => p.end >= lo && p.end <= hi && nearVehicle(last(p)))
      if (outs.length === 0 || ins.length === 0) continue
      const firstOut = Math.min(...outs.map((p) => p.start))
      const lastIn = Math.max(...ins.map((p) => p.end))
      if (firstOut > lastIn) continue
      const personIds = [...new Set([...outs, ...ins].map((p) => p.id))].sort((a, b) => a - b)

      for (const o of objects) {
        if (flagged.has(o.id)) continue
        if (o.start < stop.start || o.start > stop.end + cfg.revealSlackSec) continue
        const oc = center(first(o).box)
        if (pointToBoxW(oc.cx, oc.cy, vbox, aspect) > cfg.objectNear) continue
        if (o.end < v.end + cfg.outlastSec) continue
        if (!isStillDuring(o.points, v.end, o.end, cfg.stayMaxMove, aspect)) continue
        flagged.add(o.id)
        events.push({
          id: `left-behind-${o.id}`,
          kind: 'left-behind',
          confidence: 'higher',
          onset: o.start,
          objectTrackId: o.id,
          objectLabel: o.label,
          cx: oc.cx,
          cy: oc.cy,
          stayedSec: round3(o.end - o.start),
          vehicleTrackId: v.id,
          vehicleLabel: v.label,
          stop,
          personTrackIds: personIds,
        })
      }
    }
  }

  for (const o of objects) {
    if (flagged.has(o.id)) continue
    if (o.start < cfg.clipStart + cfg.midClipGraceSec) continue
    const still = stationaryIntervals(o.points, cfg.stayMaxMove, cfg.appearedMinSec, aspect)
    if (!still.some((iv) => longestUnattendedSec(o, iv, persons) >= cfg.unattendedMinSec)) continue
    const oc = center(first(o).box)
    flagged.add(o.id)
    events.push({
      id: `appeared-stayed-${o.id}`,
      kind: 'appeared-stayed',
      confidence: 'lower',
      onset: o.start,
      objectTrackId: o.id,
      objectLabel: o.label,
      cx: oc.cx,
      cy: oc.cy,
      stayedSec: round3(o.end - o.start),
      vehicleTrackId: null,
      vehicleLabel: null,
      stop: null,
      personTrackIds: [],
    })
  }

  return events.sort((a, b) => a.onset - b.onset || a.objectTrackId - b.objectTrackId)
}

/* ---------- Summary and formatting ---------- */

export interface Summary {
  frames: number
  seconds: number
  tracks: Record<Group, number>
  leftBehind: number
  appearedStayed: number
}

export function summarize(tracks: readonly Track[], events: readonly CueEvent[], frames: number, seconds: number): Summary {
  const counts: Record<Group, number> = { vehicle: 0, person: 0, object: 0 }
  for (const t of tracks) counts[t.group]++
  return {
    frames,
    seconds: round3(seconds),
    tracks: counts,
    leftBehind: events.filter((e) => e.kind === 'left-behind').length,
    appearedStayed: events.filter((e) => e.kind === 'appeared-stayed').length,
  }
}

/** 74.6 -> "1:14". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
