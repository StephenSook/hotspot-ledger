import { useRef, useState } from 'react'
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { Frame } from './hud'
import { classifyPhoto, explain, type ClassifyResult } from '../lib/api'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm'
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const MAX_SIDE = 1024

let detectorPromise: Promise<FaceDetector> | null = null
function faceDetector() {
  detectorPromise ??= FilesetResolver.forVisionTasks(WASM).then((fs) =>
    FaceDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'IMAGE', minDetectionConfidence: 0.4 }),
  )
  return detectorPromise
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Draws the photo scaled down, blurs every detected face, returns a JPEG data URL and the face count. */
async function blurFaces(file: File, canvas: HTMLCanvasElement): Promise<{ dataUrl: string; faces: number }> {
  const img = await loadImage(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const det = await faceDetector()
  const result = det.detect(canvas)
  for (const d of result.detections) {
    const b = d.boundingBox
    if (!b) continue
    const pad = 0.35
    const x = Math.max(0, b.originX - b.width * pad), y = Math.max(0, b.originY - b.height * pad)
    const w = Math.min(canvas.width - x, b.width * (1 + 2 * pad)), h = Math.min(canvas.height - y, b.height * (1 + 2 * pad))
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.filter = 'blur(22px)'
    ctx.drawImage(canvas, 0, 0)
    ctx.restore()
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(x, y, w, h)
  }
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), faces: result.detections.length }
}

export default function FieldPhoto({ onResult }: { onResult?: (r: ClassifyResult) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'idle' | 'blurring' | 'ready' | 'checking' | 'done' | 'error'>('idle')
  const [faces, setFaces] = useState(0)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [result, setResult] = useState<ClassifyResult | null>(null)
  const [message, setMessage] = useState('')

  async function pick(file: File | undefined) {
    if (!file || !canvasRef.current) return
    setResult(null); setMessage(''); setState('blurring')
    try {
      const out = await blurFaces(file, canvasRef.current)
      setDataUrl(out.dataUrl); setFaces(out.faces); setState('ready')
    } catch {
      setState('error'); setMessage('Could not read that image on this device. Try a JPEG or PNG.')
    }
  }

  async function check() {
    if (!dataUrl) return
    setState('checking')
    const r = await classifyPhoto(dataUrl)
    if (r.ok) { setResult(r.data); setState('done'); onResult?.(r.data) } else { setState('error'); setMessage(explain(r.error, r.status)) }
  }

  return (
    <Frame className="stack" label="Field photo">
      <span className="lbl-w">Field photo</span>
      <p style={{ fontSize: 12 }}>Take or pick a photo of a pile. Faces are blurred on this device before anything leaves it. Plates are never read.</p>
      <label className="btn solid" style={{ alignSelf: 'flex-start' }}>
        Choose photo
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <canvas ref={canvasRef} style={{ width: '100%', display: dataUrl ? 'block' : 'none', border: '1px solid var(--line)' }} aria-label="Photo preview with faces blurred" />
      <p className="lbl" aria-live="polite">
        {state === 'blurring' && 'Blurring faces on this device'}
        {(state === 'ready' || state === 'done' || state === 'checking') && `${faces} face${faces === 1 ? '' : 's'} blurred on device`}
      </p>
      {dataUrl && (
        <button className="btn" onClick={check} disabled={state === 'checking'}>
          {state === 'checking' ? 'Checking' : 'Check the pile with Gemini (staff)'}
        </button>
      )}
      {result && (
        <dl className="readout lbl">
          <dt>Items</dt><dd>{result.items.join(', ') || 'none'}</dd>
          <dt>Tires (estimate)</dt><dd>{result.tire_count_estimate ?? 'n/a'}</dd>
          <dt>Likely dumping</dt><dd>{result.is_dumping_likely ? 'yes' : 'no'}</dd>
        </dl>
      )}
      {result?.notes && <p className="dim" style={{ fontSize: 12 }}>{result.notes}</p>}
      {result && result.tire_count_estimate != null && result.tire_count_estimate > 25 && (
        <p className="note">More than 25 tires: a likely state storage violation to refer to EPD (Rule 391-3-4-.19).</p>
      )}
      {message && <p className="note" role="alert">{message}</p>}
    </Frame>
  )
}
