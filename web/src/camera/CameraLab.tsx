/* Camera page: review a clip from a fixed camera for the left-behind signature.
   Everything runs in the browser. The clip is read from a local object URL and never uploaded. */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import './camera.css'
import { MAX_SECONDS, SAMPLE_FPS, formatClock, type CueEvent, type Group } from './analysis.ts'
import {
  CameraError,
  analyzeClip,
  cameraSupported,
  closeDetector,
  isAbort,
  loadDetector,
  openCamera,
  startRecording,
  stopStream,
  type ClipAnalysis,
  type LoadStage,
  type Recording,
} from './detector.ts'
import SpaceTimeCube from './SpaceTimeCube.tsx'
import BoxOverlay from './BoxOverlay.tsx'

const PRIVACY = 'Runs on this device. No video is uploaded. No faces or license plates are recognized; people are boxes.'

type Counts = Record<Group, number>
const ZERO: Counts = { vehicle: 0, person: 0, object: 0 }

type Phase =
  | { kind: 'empty' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'loading-model'; stage: LoadStage }
  | { kind: 'analyzing'; done: number; total: number; counts: Counts }
  | { kind: 'ready' }
  | { kind: 'done'; result: ClipAnalysis }
  | { kind: 'error'; message: string }

interface Clip {
  url: string
  name: string
  /** Seconds, for recordings whose file carries no duration. */
  fallbackSec: number
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function Frame({ label, readout, children, className }: { label: string; readout?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`cam-frame${className ? ` ${className}` : ''}`}>
      <i className="cam-corner cam-corner--tl" aria-hidden="true" />
      <i className="cam-corner cam-corner--tr" aria-hidden="true" />
      <i className="cam-corner cam-corner--bl" aria-hidden="true" />
      <i className="cam-corner cam-corner--br" aria-hidden="true" />
      <div className="cam-frame-head">
        <span className="cam-label">{label}</span>
        {readout !== undefined && <span className="cam-readout">{readout}</span>}
      </div>
      {children}
    </div>
  )
}

function RecordingClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 500)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span className="cam-readout">
      {formatClock((now - startedAt) / 1000)} / {formatClock(MAX_SECONDS)}
    </span>
  )
}

function CountsRow({ counts }: { counts: Counts }) {
  return (
    <dl className="cam-counts">
      <div><dt>Vehicles</dt><dd>{counts.vehicle}</dd></div>
      <div><dt>People</dt><dd>{counts.person}</dd></div>
      <div><dt>Objects</dt><dd>{counts.object}</dd></div>
    </dl>
  )
}

function cueTitle(e: CueEvent): string {
  return e.kind === 'left-behind' ? 'Left behind' : 'Appeared, stayed'
}

function cueDetail(e: CueEvent): string {
  const obj = `${e.objectLabel} #${e.objectTrackId}`
  const stayed = `stayed ${Math.round(e.stayedSec)} s`
  if (e.kind === 'left-behind' && e.stop && e.vehicleLabel) {
    return `${obj} · ${e.vehicleLabel} #${e.vehicleTrackId} stopped ${formatClock(e.stop.start)} to ${formatClock(e.stop.end)} · ${stayed}`
  }
  return `${obj} · ${stayed}`
}

function doneSentence(r: ClipAnalysis): string {
  const n = r.events.length
  const lb = r.summary.leftBehind
  if (n === 0) return `Done. ${r.tracks.length} tracks, no cues.`
  return `Done. ${n} cue${n === 1 ? '' : 's'}${lb ? `, ${lb} left behind` : ''}.`
}

export default function CameraLab() {
  const [phase, setPhase] = useState<Phase>({ kind: 'empty' })
  const [clip, setClip] = useState<Clip | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingRef = useRef<Recording | null>(null)
  const quarterRef = useRef(0)
  const reducedMotion = usePrefersReducedMotion()
  const canRecord = useMemo(() => cameraSupported(), [])

  // Free the old clip's memory once the player has moved to the new one, and on unmount.
  useEffect(() => {
    if (!clip) return
    const { url } = clip
    return () => URL.revokeObjectURL(url)
  }, [clip])

  // Stop everything when the page goes away.
  useEffect(
    () => () => {
      abortRef.current?.abort()
      recordingRef.current?.cancel()
      stopStream(streamRef.current)
      closeDetector()
    },
    [],
  )

  // Live preview while recording; the file plays afterwards.
  const recording = phase.kind === 'recording'
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (recording && streamRef.current) {
      v.srcObject = streamRef.current
      v.play().catch(() => undefined)
    } else if (v.srcObject) {
      v.srcObject = null
    }
  }, [recording])

  const run = useCallback(async (c: Clip) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    quarterRef.current = 0
    setSelectedId(null)
    setCurrentTime(0)
    try {
      setPhase({ kind: 'loading-model', stage: 'runtime' })
      setAnnounce('Loading the detector.')
      const detector = await loadDetector((stage) => {
        if (abortRef.current === ac) setPhase({ kind: 'loading-model', stage })
      })
      ac.signal.throwIfAborted()
      setPhase({ kind: 'analyzing', done: 0, total: 0, counts: ZERO })
      setAnnounce('Analyzing the clip.')
      const result = await analyzeClip(detector, c.url, {
        signal: ac.signal,
        fallbackDurationSec: c.fallbackSec,
        onProgress: (p) => {
          if (abortRef.current !== ac) return
          setPhase({ kind: 'analyzing', ...p })
          const quarter = Math.floor((p.done / p.total) * 4)
          if (quarter > quarterRef.current && quarter < 4) {
            quarterRef.current = quarter
            setAnnounce(`${quarter * 25} percent analyzed.`)
          }
        },
      })
      if (abortRef.current !== ac) return
      setPhase({ kind: 'done', result })
      setAnnounce(doneSentence(result))
    } catch (err) {
      if (abortRef.current !== ac) return
      if (isAbort(err)) {
        setPhase({ kind: 'ready' })
        setAnnounce('Analysis cancelled.')
        return
      }
      const message =
        err instanceof CameraError ? err.message : 'Something went wrong during analysis. Reload the page and try again.'
      setPhase({ kind: 'error', message })
      setAnnounce(message)
    } finally {
      if (abortRef.current === ac) abortRef.current = null
    }
  }, [])

  const stopCamera = useCallback(() => {
    recordingRef.current?.cancel()
    recordingRef.current = null
    stopStream(streamRef.current)
    streamRef.current = null
  }, [])

  const takeFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      stopCamera()
      if (file.type && !file.type.startsWith('video/')) {
        // The person meant to replace the clip, so drop the old one: "Try again" must not
        // quietly re-run a clip they moved away from.
        abortRef.current?.abort()
        abortRef.current = null
        setClip(null)
        setPhase({ kind: 'error', message: 'That file is not a video. Choose an MP4 or WebM file.' })
        setAnnounce('That file is not a video.')
        return
      }
      const c: Clip = { url: URL.createObjectURL(file), name: file.name, fallbackSec: 0 }
      setClip(c)
      void run(c)
    },
    [run, stopCamera],
  )

  const startCamera = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = null
    stopCamera()
    try {
      const stream = await openCamera()
      streamRef.current = stream
      const rec = startRecording(
        stream,
        MAX_SECONDS,
        (blob, seconds) => {
          recordingRef.current = null
          stopStream(streamRef.current)
          streamRef.current = null
          const c: Clip = { url: URL.createObjectURL(blob), name: `Camera clip ${formatClock(seconds)}`, fallbackSec: seconds }
          setClip(c)
          void run(c)
        },
        (err) => {
          stopCamera()
          setPhase({ kind: 'error', message: err.message })
          setAnnounce(err.message)
        },
      )
      recordingRef.current = rec
      setClip(null)
      setPhase({ kind: 'recording', startedAt: rec.startedAt })
      setAnnounce(`Recording. Stop when done, or it stops at ${formatClock(MAX_SECONDS)}.`)
    } catch (err) {
      stopCamera()
      const message = err instanceof CameraError ? err.message : 'The camera could not start. Choose a video file instead.'
      setPhase({ kind: 'error', message })
      setAnnounce(message)
    }
  }, [run, stopCamera])

  const cancelRecording = useCallback(() => {
    stopCamera()
    setPhase(clip ? { kind: 'ready' } : { kind: 'empty' })
    setAnnounce('Recording discarded.')
  }, [clip, stopCamera])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    stopCamera()
    setClip(null)
    setSelectedId(null)
    setPhase({ kind: 'empty' })
  }, [stopCamera])

  const chooseFile = useCallback(() => fileRef.current?.click(), [])

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v) return
      v.pause()
      v.currentTime = t
      setCurrentTime(t)
      v.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
    },
    [reducedMotion],
  )

  const result = phase.kind === 'done' ? phase.result : null
  const selected = useMemo(
    () => (result && selectedId ? result.events.find((e) => e.id === selectedId) ?? null : null),
    [result, selectedId],
  )
  const highlight = useMemo(() => {
    const ids = new Set<number>()
    if (selected) {
      ids.add(selected.objectTrackId)
      if (selected.vehicleTrackId !== null) ids.add(selected.vehicleTrackId)
      selected.personTrackIds.forEach((id) => ids.add(id))
    }
    return ids
  }, [selected])

  const selectEvent = useCallback(
    (e: CueEvent) => {
      setSelectedId(e.id)
      seek(e.onset)
      setAnnounce(`${cueTitle(e)}, ${e.objectLabel}. Video at ${formatClock(e.onset)}.`)
    },
    [seek],
  )

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setDragOver(false)
    takeFile(e.dataTransfer.files[0])
  }
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }

  const busy = phase.kind === 'loading-model' || phase.kind === 'analyzing'
  const showPlayer = phase.kind !== 'empty' && (clip !== null || recording)

  return (
    <section className="cam-lab" aria-labelledby="cam-title" onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <header className="cam-head">
        <div>
          <p className="cam-label">Camera · left-behind signature</p>
          <h2 id="cam-title" className="cam-title">Space-time cube</h2>
        </div>
        <p className="cam-privacy">{PRIVACY}</p>
      </header>

      <p className="cam-sr" role="status" aria-live="polite">{announce}</p>

      <input
        ref={fileRef}
        id="cam-file"
        className="cam-file"
        type="file"
        accept="video/*"
        aria-label="Video file"
        tabIndex={-1}
        onChange={(e) => {
          takeFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {phase.kind === 'empty' && (
        <Frame label="No clip" className={`cam-drop${dragOver ? ' is-over' : ''}`}>
          <div className="cam-empty">
            <p className="cam-lede">Choose a clip from a fixed camera at a dumping spot.</p>
            <p className="cam-note">
              It flags a vehicle that stops, a person who gets out and back in, and an object still there after the vehicle leaves.
            </p>
            <div className="cam-btn-row">
              <button type="button" className="cam-btn cam-btn--signal" onClick={chooseFile}>Choose a video</button>
              {canRecord && (
                <button type="button" className="cam-btn" onClick={() => void startCamera()}>Record from camera</button>
              )}
            </div>
            <p className="cam-note cam-note--dim">
              Reads up to {formatClock(MAX_SECONDS)}, {SAMPLE_FPS} frames a second. You can also drop a file here.
            </p>
          </div>
        </Frame>
      )}

      {phase.kind !== 'empty' && (
        <div className="cam-grid">
          <Frame
            label={recording ? 'Recording' : 'Clip'}
            readout={recording ? <RecordingClock startedAt={phase.startedAt} /> : clip?.name}
          >
            <div className="cam-video-wrap">
              {showPlayer && (
                <video
                  ref={videoRef}
                  className="cam-video"
                  src={recording ? undefined : clip?.url}
                  controls={!recording}
                  muted
                  playsInline
                  aria-label={recording ? 'Camera preview' : 'Clip player'}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
                />
              )}
              {result && <BoxOverlay videoRef={videoRef} times={result.times} tracks={result.tracks} highlight={highlight} />}
              {recording && <span className="cam-rec" aria-hidden="true">REC</span>}
            </div>

            <div className="cam-controls">
              {recording && (
                <div className="cam-btn-row">
                  <button type="button" className="cam-btn cam-btn--signal" onClick={() => recordingRef.current?.stop()}>
                    Stop and analyze
                  </button>
                  <button type="button" className="cam-btn" onClick={cancelRecording}>Discard</button>
                </div>
              )}

              {phase.kind === 'loading-model' && (
                <>
                  <p className="cam-progress-text">
                    {phase.stage === 'runtime'
                      ? 'Loading the detector runtime.'
                      : 'Downloading the detector model (about 7 MB). Only the model is downloaded.'}
                  </p>
                  <div className="cam-btn-row">
                    <button type="button" className="cam-btn" onClick={() => abortRef.current?.abort()}>Cancel</button>
                  </div>
                </>
              )}

              {phase.kind === 'analyzing' && (
                <>
                  <progress
                    className="cam-progress"
                    max={Math.max(phase.total, 1)}
                    value={phase.done}
                    aria-label="Frames analyzed"
                  />
                  <p className="cam-progress-text" aria-hidden="true">
                    Frame {phase.done} of {phase.total || '...'}
                  </p>
                  <div className="cam-btn-row">
                    <button type="button" className="cam-btn" onClick={() => abortRef.current?.abort()}>Cancel</button>
                  </div>
                </>
              )}

              {phase.kind === 'ready' && clip && (
                <div className="cam-btn-row">
                  <button type="button" className="cam-btn cam-btn--signal" onClick={() => void run(clip)}>Analyze</button>
                  <button type="button" className="cam-btn" onClick={chooseFile}>Choose another video</button>
                </div>
              )}

              {phase.kind === 'error' && (
                <>
                  <p className="cam-error" role="alert">{phase.message}</p>
                  <div className="cam-btn-row">
                    {clip && (
                      <button type="button" className="cam-btn cam-btn--signal" onClick={() => void run(clip)}>Try again</button>
                    )}
                    <button type="button" className="cam-btn" onClick={chooseFile}>Choose another video</button>
                    <button type="button" className="cam-btn" onClick={reset}>Start over</button>
                  </div>
                </>
              )}

              {phase.kind === 'done' && (
                <div className="cam-btn-row">
                  <button type="button" className="cam-btn" onClick={chooseFile}>Choose another video</button>
                  {canRecord && (
                    <button type="button" className="cam-btn" onClick={() => void startCamera()}>Record from camera</button>
                  )}
                </div>
              )}
            </div>
          </Frame>

          <Frame label="Space-time cube" readout="Floor = frame · up = time">
            {result ? (
              <SpaceTimeCube
                aspect={result.aspect}
                seconds={result.analyzedSec}
                tracks={result.tracks}
                events={result.events}
                currentTime={currentTime}
                selected={selected}
                onSeek={seek}
                onSelectEvent={selectEvent}
              />
            ) : (
              <div className="cam-cube cam-cube--idle">
                {busy && phase.kind === 'analyzing' && <CountsRow counts={phase.counts} />}
                <p className="cam-cube-msg">
                  {recording && 'The cube is drawn after you stop recording.'}
                  {phase.kind === 'loading-model' && 'Waiting for the detector.'}
                  {phase.kind === 'analyzing' && 'Tracks found so far.'}
                  {phase.kind === 'ready' && 'Press Analyze to build the cube.'}
                  {phase.kind === 'error' && 'No cube for this clip yet.'}
                </p>
              </div>
            )}
          </Frame>
        </div>
      )}

      {result && (
        <div className="cam-grid cam-grid--below">
          <Frame label="Cues" readout={`${result.events.length}`}>
            {result.events.length === 0 ? (
              <p className="cam-note">No cues in this clip. Every track is still drawn in the cube.</p>
            ) : (
              <ol className="cam-cues">
                {result.events.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      className={`cam-cue cam-cue--${e.kind}`}
                      aria-pressed={selectedId === e.id}
                      onClick={() => selectEvent(e)}
                    >
                      <span className="cam-cue-time">{formatClock(e.onset)}</span>
                      <span className="cam-cue-kind">{cueTitle(e)}</span>
                      <span className="cam-cue-what">{cueDetail(e)}</span>
                      <span className="cam-cue-conf">{e.confidence}<span className="cam-sr"> confidence. Seek the video here.</span></span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <p className="cam-note cam-note--dim">A cue is a lead for a person to review, not proof of dumping.</p>
          </Frame>

          <Frame label="Counts">
            <dl className="cam-counts cam-counts--wide">
              <div><dt>Frames</dt><dd>{result.summary.frames}</dd></div>
              <div><dt>Seconds read</dt><dd>{result.summary.seconds.toFixed(1)}</dd></div>
              <div><dt>Vehicles</dt><dd>{result.summary.tracks.vehicle}</dd></div>
              <div><dt>People</dt><dd>{result.summary.tracks.person}</dd></div>
              <div><dt>Objects</dt><dd>{result.summary.tracks.object}</dd></div>
              <div><dt>Left behind</dt><dd className={result.summary.leftBehind ? 'is-signal' : undefined}>{result.summary.leftBehind}</dd></div>
              <div><dt>Appeared, stayed</dt><dd>{result.summary.appearedStayed}</dd></div>
            </dl>
            {result.truncated && (
              <p className="cam-note cam-note--dim">
                Read the first {formatClock(result.analyzedSec)} of {formatClock(result.duration)}.
              </p>
            )}
            {result.skipped > 0 && (
              <p className="cam-note cam-note--dim">{result.skipped} frames skipped because the browser was slow to seek.</p>
            )}
          </Frame>
        </div>
      )}
    </section>
  )
}
