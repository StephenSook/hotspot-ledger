/* MediaPipe Tasks object detector, frame sampling, and camera recording for the Camera page.
   Everything runs in this tab. The only network requests are for the detector runtime (jsDelivr)
   and the model file (Google storage). The video never leaves the device. */
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision'
import {
  MAX_SECONDS,
  createTracker,
  detectCues,
  sampleTimes,
  summarize,
  toFrame,
  type CueEvent,
  type Group,
  type Summary,
  type Track,
} from './analysis.ts'

export const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm'
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'
export const SCORE_THRESHOLD = 0.35
const MAX_RESULTS = 25

export type CameraErrorCode = 'model' | 'video' | 'camera' | 'unsupported'

/** An error with a message written for the person using the page. */
export class CameraError extends Error {
  readonly code: CameraErrorCode
  constructor(code: CameraErrorCode, message: string) {
    super(message)
    this.name = 'CameraError'
    this.code = code
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/* ---------- One shared detector ---------- */

export type LoadStage = 'runtime' | 'model'

let detectorPromise: Promise<ObjectDetector> | null = null
let lastTimestamp = 0

/** Loads the detector once and reuses it. A failed load clears the cache so a retry can work. */
export function loadDetector(onStage?: (stage: LoadStage) => void): Promise<ObjectDetector> {
  if (detectorPromise) return detectorPromise
  const p = (async () => {
    onStage?.('runtime')
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
    onStage?.('model')
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      scoreThreshold: SCORE_THRESHOLD,
      maxResults: MAX_RESULTS,
    })
    try {
      return await ObjectDetector.createFromOptions(fileset, options('GPU'))
    } catch {
      try {
        return await ObjectDetector.createFromOptions(fileset, options('CPU'))
      } catch {
        throw new CameraError(
          'model',
          'Could not load the detector model. Check the internet connection, then try again.',
        )
      }
    }
  })()
  detectorPromise = p
  p.catch(() => {
    if (detectorPromise === p) detectorPromise = null
  })
  return p
}

/** Frees the detector's memory. The next analysis loads it again. */
export function closeDetector(): void {
  const p = detectorPromise
  detectorPromise = null
  p?.then((d) => d.close()).catch(() => undefined)
}

/** VIDEO mode needs strictly increasing timestamps across every call on one detector,
    including across clips, so this never restarts at zero. */
function nextTimestamp(): number {
  lastTimestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()))
  return lastTimestamp
}

/* ---------- Video helpers ---------- */

function waitFor(
  target: HTMLMediaElement,
  ok: readonly string[],
  bad: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      ok.forEach((e) => target.removeEventListener(e, onOk))
      bad.forEach((e) => target.removeEventListener(e, onBad))
      signal?.removeEventListener('abort', onAbort)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onBad = () => {
      cleanup()
      reject(new Error('media error'))
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, timeoutMs)
    ok.forEach((e) => target.addEventListener(e, onOk))
    bad.forEach((e) => target.addEventListener(e, onBad))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort)
  })
}

export function releaseVideo(v: HTMLVideoElement): void {
  v.pause()
  v.removeAttribute('src')
  v.load()
}

/** A detached video element used only for sampling, so the visible player stays free. */
async function openVideo(url: string, signal: AbortSignal): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  const loaded = waitFor(v, ['loadeddata'], ['error'], 20000, signal)
  v.src = url
  try {
    await loaded
  } catch (err) {
    releaseVideo(v)
    if (isAbort(err)) throw err
    throw new CameraError('video', 'This browser cannot read this video. Try an MP4 (H.264) or WebM file.')
  }
  if (!v.videoWidth || !v.videoHeight) {
    releaseVideo(v)
    throw new CameraError('video', 'This file has no picture. Choose a video file.')
  }
  return v
}

/** Recordings from MediaRecorder in Chrome report an infinite duration until the browser is made
    to scan the file; seeking far past the end does that. */
async function resolveDuration(v: HTMLVideoElement, fallbackSec: number, signal: AbortSignal): Promise<number> {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration
  try {
    const settled = waitFor(v, ['durationchange', 'seeked'], [], 4000, signal)
    v.currentTime = 1e7
    await settled
  } catch (err) {
    if (isAbort(err)) throw err
  }
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration
  if (fallbackSec > 0) return fallbackSec
  throw new CameraError('video', 'Could not read the length of this video. Try an MP4 file.')
}

async function seekTo(v: HTMLVideoElement, t: number, signal: AbortSignal): Promise<void> {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return
  const done = waitFor(v, ['seeked'], ['error'], 8000, signal)
  v.currentTime = t
  await done
  if (v.readyState < 2) await waitFor(v, ['loadeddata', 'canplay'], ['error'], 4000, signal)
}

/* ---------- Clip analysis ---------- */

export interface AnalyzeProgress {
  done: number
  total: number
  counts: Record<Group, number>
}

export interface ClipAnalysis {
  width: number
  height: number
  /** height / width */
  aspect: number
  /** Full clip length in seconds. */
  duration: number
  /** Seconds actually read (at most MAX_SECONDS). */
  analyzedSec: number
  truncated: boolean
  /** Sample times that were analyzed. */
  times: number[]
  /** Samples skipped because the browser did not finish seeking in time. */
  skipped: number
  tracks: Track[]
  events: CueEvent[]
  summary: Summary
}

/** Samples the clip about 4 times a second, one frame at a time, through one detector. */
export async function analyzeClip(
  detector: ObjectDetector,
  url: string,
  opts: { signal: AbortSignal; fallbackDurationSec?: number; onProgress?: (p: AnalyzeProgress) => void },
): Promise<ClipAnalysis> {
  const { signal } = opts
  const video = await openVideo(url, signal)
  try {
    const duration = await resolveDuration(video, opts.fallbackDurationSec ?? 0, signal)
    const planned = sampleTimes(duration)
    if (planned.length === 0) throw new CameraError('video', 'This video is empty. Choose another file.')
    const width = video.videoWidth
    const height = video.videoHeight
    const aspect = height / width
    const tracker = createTracker({ aspect })
    const times: number[] = []
    let skipped = 0

    for (let i = 0; i < planned.length; i++) {
      signal.throwIfAborted()
      const t = planned[i]
      try {
        await seekTo(video, t, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        skipped++
        if (skipped > Math.max(8, planned.length / 4)) {
          throw new CameraError('video', 'The browser could not step through this video. Try an MP4 (H.264) file.')
        }
        continue
      }
      signal.throwIfAborted()
      let detections
      try {
        detections = detector.detectForVideo(video, nextTimestamp()).detections
      } catch {
        throw new CameraError('model', 'The detector stopped partway. Reload the page and try again.')
      }
      tracker.push(toFrame(t, detections, width, height))
      times.push(t)
      opts.onProgress?.({ done: i + 1, total: planned.length, counts: tracker.counts() })
    }

    if (times.length === 0) throw new CameraError('video', 'No frames could be read from this video.')
    const tracks = tracker.tracks()
    const events = detectCues(tracks, { aspect, clipStart: times[0], clipEnd: times[times.length - 1] })
    const analyzedSec = Math.min(duration, MAX_SECONDS)
    return {
      width,
      height,
      aspect,
      duration,
      analyzedSec,
      truncated: duration > MAX_SECONDS + 0.01,
      times,
      skipped,
      tracks,
      events,
      summary: summarize(tracks, events, times.length, analyzedSec),
    }
  } finally {
    releaseVideo(video)
  }
}

/* ---------- Camera recording ---------- */

export function cameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  )
}

export async function openCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraError('camera', 'The camera needs a secure page. Open this site over https or on localhost.')
  }
  if (!cameraSupported()) {
    throw new CameraError('unsupported', 'This browser cannot record from a camera here. Choose a video file instead.')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('camera', 'Camera access was blocked. Allow the camera in the browser settings, or choose a video file.')
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('camera', 'No camera was found. Choose a video file instead.')
    }
    throw new CameraError('camera', 'The camera could not start. Close other apps that use it, or choose a video file.')
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

function pickRecorderType(): string | undefined {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
  return candidates.find((c) => MediaRecorder.isTypeSupported(c))
}

export interface Recording {
  startedAt: number
  /** Stop and hand the clip to onDone. */
  stop(): void
  /** Stop and throw the clip away. */
  cancel(): void
}

/** Records the stream for at most `maxSec` seconds. About 28 MB at most at 2.5 Mbps. */
export function startRecording(
  stream: MediaStream,
  maxSec: number,
  onDone: (blob: Blob, seconds: number) => void,
  onError: (err: CameraError) => void,
): Recording {
  const mimeType = pickRecorderType()
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined)
  } catch {
    throw new CameraError('unsupported', 'This browser cannot record video here. Choose a video file instead.')
  }
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let cancelled = false
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  rec.onstop = () => {
    clearTimeout(timer)
    if (cancelled) return
    const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' })
    chunks.length = 0
    if (blob.size === 0) onError(new CameraError('camera', 'The recording came out empty. Try again.'))
    else onDone(blob, (performance.now() - startedAt) / 1000)
  }
  rec.onerror = () => onError(new CameraError('camera', 'Recording stopped with an error. Try again, or choose a video file.'))
  rec.start(1000)
  const timer = setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop()
  }, maxSec * 1000)
  return {
    startedAt,
    stop: () => {
      if (rec.state !== 'inactive') rec.stop()
    },
    cancel: () => {
      cancelled = true
      clearTimeout(timer)
      chunks.length = 0
      if (rec.state !== 'inactive') rec.stop()
    },
  }
}
