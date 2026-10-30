// @vitest-environment node
// Pure functions only: no DOM needed, so this file skips jsdom.
import { describe, expect, it } from 'vitest'
import {
  createTracker,
  detectCues,
  formatClock,
  groupForLabel,
  iou,
  matchScore,
  sampleTimes,
  stationaryIntervals,
  toFrame,
  trackFrames,
  type Box,
  type Frame,
  type RawDetection,
  type Track,
  type TrackPoint,
} from './analysis.ts'

/* Synthetic clips: 4 samples a second on a 16:9 frame, the same sampling the page uses. */
const ASPECT = 9 / 16

const det = (label: string, x: number, y: number, w: number, h: number, score = 0.8): RawDetection => ({
  label,
  score,
  box: { x, y, w, h },
})

const lerp = (a: number, b: number, k: number): number => a + (b - a) * Math.min(1, Math.max(0, k))

function clip(seconds: number, build: (t: number) => RawDetection[]): Frame[] {
  return sampleTimes(seconds).map((t) => ({ t, detections: build(t) }))
}

function cuesFor(frames: Frame[]) {
  const tracks = trackFrames(frames, ASPECT)
  const events = detectCues(tracks, {
    aspect: ASPECT,
    clipStart: frames[0].t,
    clipEnd: frames[frames.length - 1].t,
  })
  return { tracks, events }
}

/** A vehicle that drives in, stops from 3 s to 12 s at x = 0.4, then drives out by 15 s. */
function stoppingVehicle(label: string, t: number): RawDetection[] {
  if (t > 15) return []
  let x: number
  if (t < 3) x = lerp(0, 0.4, t / 3)
  else if (t <= 12) x = 0.4 + 0.003 * Math.sin(t * 7) // detector jitter on a parked vehicle
  else x = lerp(0.4, 0.8, (t - 12) / 3)
  return [det(label, x, 0.5, 0.2, 0.15)]
}

/** A person who gets out next to the vehicle at 4 s, walks to x = 0.75 and back, and gets in at 9.5 s. */
function personLoopX(t: number): number | null {
  if (t < 4 || t > 9.5) return null
  if (t <= 6) return lerp(0.61, 0.75, (t - 4) / 2)
  if (t <= 9) return lerp(0.75, 0.61, (t - 6) / 3)
  return 0.61
}

function personLoop(t: number): RawDetection[] {
  const x = personLoopX(t)
  return x === null ? [] : [det('person', x, 0.45, 0.05, 0.2)]
}

describe('iou', () => {
  const a: Box = { x: 0, y: 0, w: 0.2, h: 0.2 }
  it('is 1 for identical boxes and 0 for disjoint boxes', () => {
    expect(iou(a, a)).toBeCloseTo(1)
    expect(iou(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0)
    expect(iou(a, { x: 0.2, y: 0, w: 0.2, h: 0.2 })).toBe(0) // touching edges only
  })
  it('is 1/3 for two equal boxes overlapping by half their width', () => {
    expect(iou(a, { x: 0.1, y: 0, w: 0.2, h: 0.2 })).toBeCloseTo(1 / 3)
  })
  it('is the area ratio for a box inside another', () => {
    expect(iou(a, { x: 0.05, y: 0.05, w: 0.1, h: 0.1 })).toBeCloseTo(0.25)
  })
})

describe('matchScore', () => {
  const cfg = { aspect: ASPECT, minIou: 0.3, centerGate: 0.75 }
  const car: Box = { x: 0.3, y: 0.5, w: 0.2, h: 0.15 }
  it('ranks any IoU match above any center-distance fallback', () => {
    const iouMatch = matchScore(car, { ...car, x: 0.33 }, cfg)
    const fallback = matchScore(car, { ...car, x: 0.45 }, cfg)
    expect(iouMatch).toBeGreaterThan(1)
    expect(fallback).toBeGreaterThan(0)
    expect(fallback).toBeLessThan(1)
  })
  it('refuses far jumps and big size changes', () => {
    expect(matchScore(car, { ...car, x: 0.7 }, cfg)).toBe(0)
    expect(matchScore(car, { x: 0.3, y: 0.5, w: 0.05, h: 0.05 }, cfg)).toBe(0)
  })
})

describe('tracker (IoU matching)', () => {
  it('keeps one id for a steadily moving car', () => {
    const frames = clip(5, (t) => [det('car', lerp(0, 0.6, t / 5), 0.4, 0.2, 0.15)])
    const tracks = trackFrames(frames, ASPECT)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].points).toHaveLength(frames.length)
    expect(tracks[0].group).toBe('vehicle')
  })

  it('keeps two cars in two lanes apart, with no id swap', () => {
    const frames = clip(5, (t) => [
      det('car', lerp(0, 0.6, t / 5), 0.2, 0.2, 0.15),
      det('car', lerp(0.7, 0.1, t / 5), 0.6, 0.2, 0.15),
    ])
    const tracks = trackFrames(frames, ASPECT)
    expect(tracks).toHaveLength(2)
    for (const tr of tracks) {
      const ys = new Set(tr.points.map((p) => p.box.y))
      expect(ys.size).toBe(1)
    }
  })

  it('follows a fast car whose boxes barely overlap between samples', () => {
    const frames = clip(1.5, (t) => [det('car', lerp(0, 0.75, t / 1.5), 0.4, 0.2, 0.15)])
    expect(iou(frames[0].detections[0].box, frames[1].detections[0].box)).toBeLessThan(0.3)
    expect(trackFrames(frames, ASPECT)).toHaveLength(1)
  })

  it('bridges a short gap for an object but starts a new person track after a long gap', () => {
    const frames = clip(8, (t) => {
      const out: RawDetection[] = []
      if (t < 3 || t > 4) out.push(det('suitcase', 0.5, 0.6, 0.06, 0.08)) // hidden for 1 s
      if (t < 2 || t > 4.5) out.push(det('person', 0.2, 0.3, 0.05, 0.2)) // hidden for 2.5 s
      return out
    })
    const tracks = trackFrames(frames, ASPECT)
    expect(tracks.filter((t) => t.group === 'object')).toHaveLength(1)
    expect(tracks.filter((t) => t.group === 'person')).toHaveLength(2)
  })

  it('keeps the majority label and never matches across groups', () => {
    const labels = ['car', 'car', 'truck', 'car', 'car']
    const tracker = createTracker({ aspect: ASPECT })
    labels.forEach((label, i) => {
      tracker.push({
        t: i * 0.25,
        detections: [det(label, 0.3, 0.3, 0.2, 0.15), det('suitcase', 0.3, 0.3, 0.2, 0.15)],
      })
    })
    const tracks = tracker.tracks()
    expect(tracks).toHaveLength(2)
    expect(tracks.find((t) => t.group === 'vehicle')?.label).toBe('car')
    expect(tracks.find((t) => t.group === 'object')?.label).toBe('suitcase')
    expect(tracker.counts()).toEqual({ vehicle: 1, person: 0, object: 1 })
  })

  it('ignores animals and street furniture', () => {
    const frames = clip(3, () => [det('dog', 0.1, 0.1, 0.1, 0.1), det('fire hydrant', 0.5, 0.5, 0.03, 0.06)])
    expect(trackFrames(frames, ASPECT)).toHaveLength(0)
  })
})

describe('labels, frames and sampling', () => {
  it('groups COCO labels', () => {
    expect(groupForLabel('car')).toBe('vehicle')
    expect(groupForLabel('Motorcycle')).toBe('vehicle')
    expect(groupForLabel('person')).toBe('person')
    expect(groupForLabel('couch')).toBe('object')
    expect(groupForLabel('sofa')).toBe('object')
    expect(groupForLabel('refrigerator')).toBe('object')
    expect(groupForLabel('bicycle')).toBe('object')
    expect(groupForLabel('cat')).toBeNull()
    expect(groupForLabel('stop sign')).toBeNull()
    expect(groupForLabel('???')).toBeNull()
  })

  it('converts pixel boxes to normalized boxes and keeps the top category', () => {
    const frame = toFrame(
      1.5,
      [
        {
          categories: [
            { categoryName: 'truck', score: 0.4 },
            { categoryName: 'car', score: 0.7 },
          ],
          boundingBox: { originX: 160, originY: 90, width: 320, height: 180 },
        },
        { categories: [{ categoryName: 'person', score: 0.9 }] },
      ],
      640,
      360,
    )
    expect(frame.t).toBe(1.5)
    expect(frame.detections).toHaveLength(1)
    expect(frame.detections[0].label).toBe('car')
    expect(frame.detections[0].box).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })

  it('samples 4 times a second for at most 90 seconds', () => {
    expect(sampleTimes(2)).toEqual([0.125, 0.375, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875])
    const long = sampleTimes(200)
    expect(long).toHaveLength(360)
    expect(long[long.length - 1]).toBe(89.875)
    expect(sampleTimes(Number.NaN)).toEqual([])
  })

  it('formats clock times', () => {
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(74.6)).toBe('1:14')
  })
})

describe('stationary detection', () => {
  const pts = (fn: (t: number) => number, seconds: number): TrackPoint[] =>
    sampleTimes(seconds).map((t) => ({ t, score: 0.8, box: { x: fn(t), y: 0.5, w: 0.2, h: 0.15 } }))

  it('finds a parked vehicle despite detector jitter', () => {
    const iv = stationaryIntervals(pts((t) => 0.4 + 0.004 * Math.sin(t * 5), 4), 0.02, 2, ASPECT)
    expect(iv).toHaveLength(1)
    expect(iv[0].end - iv[0].start).toBeGreaterThan(3.5)
  })

  it('finds nothing for a vehicle that keeps moving', () => {
    expect(stationaryIntervals(pts((t) => 0.04 * t, 6), 0.02, 2, ASPECT)).toEqual([])
  })

  it('finds nothing for a slow drift that never stays put', () => {
    expect(stationaryIntervals(pts((t) => 0.4 + 0.017 * t, 10), 0.03, 3, ASPECT)).toEqual([])
  })

  it('needs at least the minimum duration', () => {
    expect(stationaryIntervals(pts(() => 0.4, 1.5), 0.02, 2, ASPECT)).toEqual([])
  })

  it('keeps one stop when a person blocks the vehicle for half a second', () => {
    const iv = stationaryIntervals(pts((t) => (t > 2.5 && t < 3 ? 0.45 : 0.4), 5.5), 0.02, 2, ASPECT)
    expect(iv).toHaveLength(1)
    expect(iv[0].start).toBeLessThan(0.2)
    expect(iv[0].end).toBeGreaterThan(5.3)
  })
})

describe('left-behind signature', () => {
  it('flags a couch left after a car stops, a person loops, and the car leaves', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('car', t), ...personLoop(t)]
      if (t >= 6) out.push(det('couch', 0.66, 0.6, 0.1, 0.08))
      return out
    })
    const { tracks, events } = cuesFor(frames)
    const car = tracks.find((tr) => tr.group === 'vehicle') as Track
    const person = tracks.find((tr) => tr.group === 'person') as Track
    expect(tracks.filter((tr) => tr.group === 'vehicle')).toHaveLength(1)

    expect(events).toHaveLength(1)
    const [e] = events
    expect(e.kind).toBe('left-behind')
    expect(e.confidence).toBe('higher')
    expect(e.objectLabel).toBe('couch')
    expect(e.onset).toBe(6.125)
    expect(e.vehicleTrackId).toBe(car.id)
    expect(e.personTrackIds).toEqual([person.id])
    expect(e.stop?.start).toBeLessThanOrEqual(3.125)
    expect(e.stop?.end).toBeGreaterThanOrEqual(11.875)
  })

  it('still flags it when the person is hidden mid-loop and comes back as a new track', () => {
    const frames = clip(20, (t) => {
      const hidden = t > 6.5 && t < 8.5 // behind the car for 2 s
      const out = [...stoppingVehicle('car', t), ...(hidden ? [] : personLoop(t))]
      if (t >= 6) out.push(det('couch', 0.66, 0.6, 0.1, 0.08))
      return out
    })
    const { tracks, events } = cuesFor(frames)
    expect(tracks.filter((tr) => tr.group === 'person')).toHaveLength(2)
    expect(events.map((e) => e.kind)).toEqual(['left-behind'])
    expect(events[0].personTrackIds).toHaveLength(2)
  })

  it('does not flag a garbage truck that stops, loops a worker, and leaves with nothing new', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('truck', t), ...personLoop(t)]
      if (t < 8) out.push(det('suitcase', 0.66, 0.6, 0.06, 0.08)) // already at the curb, then picked up
      return out
    })
    const { tracks, events } = cuesFor(frames)
    expect(tracks.filter((tr) => tr.group === 'vehicle')).toHaveLength(1)
    expect(tracks.filter((tr) => tr.group === 'person')).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('does not flag a person who carries a bag out of the car and back in', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('car', t), ...personLoop(t)]
      const x = personLoopX(t)
      if (x !== null) out.push(det('backpack', x + 0.01, 0.52, 0.03, 0.06))
      return out
    })
    const { tracks, events } = cuesFor(frames)
    expect(tracks.filter((tr) => tr.group === 'object')).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('needs a person: with no one getting out, it is only the lower cue', () => {
    const frames = clip(20, (t) => {
      const out = stoppingVehicle('car', t)
      if (t >= 6) out.push(det('couch', 0.66, 0.6, 0.1, 0.08))
      return out
    })
    expect(cuesFor(frames).events.map((e) => e.kind)).toEqual(['appeared-stayed'])
  })

  it('needs the object near the vehicle: far across the frame, it is only the lower cue', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('car', t), ...personLoop(t)]
      if (t >= 6) out.push(det('couch', 0.02, 0.2, 0.1, 0.08))
      return out
    })
    expect(cuesFor(frames).events.map((e) => e.kind)).toEqual(['appeared-stayed'])
  })

  it('does not flag an object that was at the curb before the car arrived', () => {
    const frames = clip(20, (t) => [
      ...stoppingVehicle('car', t),
      ...personLoop(t),
      det('couch', 0.66, 0.6, 0.1, 0.08),
    ])
    expect(cuesFor(frames).events).toEqual([])
  })

  it('does not flag an object that keeps moving after the car leaves', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('car', t), ...personLoop(t)]
      if (t >= 6) out.push(det('suitcase', lerp(0.66, 0.9, (t - 6) / 14), 0.6, 0.06, 0.08)) // rolled or carried off
      return out
    })
    const { tracks, events } = cuesFor(frames)
    expect(tracks.filter((tr) => tr.group === 'object')).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('does not count a parked car as gone when its track breaks and resumes in place', () => {
    const frames = clip(20, (t) => {
      const hidden = t > 10 && t < 12.5 // blocked by something the detector missed
      const out = [...(hidden ? [] : stoppingVehicle('car', Math.min(t, 10))), ...personLoop(t)]
      if (t >= 6) out.push(det('couch', 0.66, 0.6, 0.1, 0.08))
      return out
    })
    const { tracks, events } = cuesFor(frames)
    expect(tracks.filter((tr) => tr.group === 'vehicle')).toHaveLength(2)
    expect(events.map((e) => e.kind)).toEqual(['appeared-stayed'])
  })

  it('does not flag an object when the vehicle never leaves the frame', () => {
    const frames = clip(20, (t) => {
      const out = [...stoppingVehicle('car', Math.min(t, 10)), ...personLoop(t)]
      if (t >= 6) out.push(det('couch', 0.66, 0.6, 0.1, 0.08))
      return out
    })
    const { events } = cuesFor(frames)
    expect(events.some((e) => e.kind === 'left-behind')).toBe(false)
  })
})

describe('appeared-and-stayed cue (lower confidence)', () => {
  it('flags an object put down mid-clip and left, and ignores one there from the start', () => {
    const frames = clip(12, (t) => {
      const out = [det('chair', 0.1, 0.7, 0.08, 0.12)] // there all along
      if (t >= 5) out.push(det('suitcase', 0.5, 0.6, 0.06, 0.08))
      if (t >= 4 && t <= 9) out.push(det('person', t <= 6 ? 0.47 : lerp(0.47, 0.95, (t - 6) / 3), 0.45, 0.05, 0.2))
      return out
    })
    const { events } = cuesFor(frames)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('appeared-stayed')
    expect(events[0].confidence).toBe('lower')
    expect(events[0].objectLabel).toBe('suitcase')
    expect(events[0].onset).toBe(5.125)
  })

  it('does not flag a bag that a standing person holds the whole time', () => {
    const frames = clip(12, (t) => {
      if (t < 4 || t > 10) return []
      return [det('person', 0.47, 0.45, 0.05, 0.2), det('handbag', 0.5, 0.55, 0.04, 0.05)]
    })
    expect(cuesFor(frames).events).toEqual([])
  })
})
