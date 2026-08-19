import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import piexif from 'piexifjs'
import { FFMPEG_BIN, FFPROBE_BIN } from './ffmpeg'
import { getConfig } from './store'

// Self-contained export protection ("spoofing"). A native port of the original
// Python spoofer: it uses the bundled ffmpeg/ffprobe binaries and a pure-JS
// EXIF writer, so it needs no external folder, Python install or third-party
// scripts.
//
// Every fingerprint surface is spoofed, and every parameter is re-randomized
// per file so no two exports share a signature:
//   Pixels    — spatial+temporal noise, sub-pixel rotation, random crop +
//               rescale (breaks perceptual hashes), tone/gamma/saturation/hue
//               jitter, light sharpen.
//   Geometry  — images land on slightly different dimensions every time;
//               videos are cropped a hair and scaled back to the source size.
//   Timing    — videos lose a random few milliseconds off the start.
//   Audio     — re-encoded with a subtle random gain change.
//   Container — all source metadata/chapters stripped; a random plausible
//               creation time, device make/model and native-looking handler
//               names are written instead of ffmpeg's own fingerprints.
//   EXIF      — images get a fully rebuilt EXIF from a random real camera /
//               phone profile.

export interface SpoofProgress {
  progress: number // 0..1
  label: string
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi'])

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function randIn(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomCreationTime(): string {
  const past = Date.now() - Math.floor(randIn(15, 540) * 24 * 3600 * 1000)
  return new Date(past).toISOString().replace(/\.\d+Z$/, 'Z')
}

const VIDEO_DEVICE_PROFILES = [
  { make: 'Apple', model: 'iPhone 15 Pro', software: '17.4.1', vHandler: 'Core Media Video', aHandler: 'Core Media Audio', compressor: 'H.264' },
  { make: 'Apple', model: 'iPhone 14 Pro Max', software: '16.6.1', vHandler: 'Core Media Video', aHandler: 'Core Media Audio', compressor: 'H.264' },
  { make: 'Apple', model: 'iPhone 13', software: '15.7', vHandler: 'Core Media Video', aHandler: 'Core Media Audio', compressor: 'H.264' },
  { make: 'samsung', model: 'SM-S928B', software: 'S928BXXU2AXC7', vHandler: 'VideoHandle', aHandler: 'SoundHandle', compressor: 'Samsung H.264 Encoder' },
  { make: 'samsung', model: 'SM-S918B', software: 'S918BXXS3BWL1', vHandler: 'VideoHandle', aHandler: 'SoundHandle', compressor: 'Samsung H.264 Encoder' },
  { make: 'Google', model: 'Pixel 8 Pro', software: 'HDR+ 1.0.585804401zd', vHandler: 'VideoHandle', aHandler: 'SoundHandle', compressor: 'Google H.264 Encoder' }
] as const

const VIDEO_TIMESCALES = [600, 15360, 30000, 90000] as const

function ffmpegBytes(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (c) => chunks.push(Buffer.from(c)))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg probe failed (${code}): ${stderr.slice(-300)}`))
    })
  })
}

async function meanLuma(filePath: string, atSeconds?: number): Promise<number> {
  const args = ['-v', 'error']
  if (atSeconds && atSeconds > 0) args.push('-ss', atSeconds.toFixed(3))
  args.push('-i', filePath, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1')
  try {
    const buf = await ffmpegBytes(args)
    if (buf.length < 3) return 0.5
    const r = buf[0] / 255
    const g = buf[1] / 255
    const b = buf[2] / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  } catch {
    return 0.5
  }
}

function exposureGamma(mean: number, target: number, lo: number, hi: number): number {
  if (mean <= 0.02) return 1.0
  return clamp(Math.log(target) / Math.log(mean), lo, hi)
}

function randomDateTime(): string {
  const year = 2022 + Math.floor(Math.random() * 3)
  const month = 1 + Math.floor(Math.random() * 12)
  const day = 1 + Math.floor(Math.random() * 28)
  const hour = Math.floor(Math.random() * 24)
  const minute = Math.floor(Math.random() * 60)
  const second = Math.floor(Math.random() * 60)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${year}:${p(month)}:${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`
}

interface ExifProfile {
  make: string
  model: string
  software: string
  lens: string
  focals: ReadonlyArray<readonly [number, number]>
  fnums: ReadonlyArray<readonly [number, number]>
  resolution: number
}

const IMAGE_EXIF_PROFILES: readonly ExifProfile[] = [
  { make: 'Canon', model: 'Canon EOS R5', software: 'Adobe Lightroom Classic 13.0', lens: 'RF 50mm F1.2 L USM', focals: [[50, 1]], fnums: [[12, 10], [14, 10], [18, 10]], resolution: 300 },
  { make: 'Canon', model: 'Canon EOS R6 Mark II', software: 'Adobe Lightroom Classic 12.4', lens: 'RF 24-70mm F2.8 L IS USM', focals: [[24, 1], [35, 1], [50, 1], [70, 1]], fnums: [[28, 10], [32, 10], [40, 10]], resolution: 300 },
  { make: 'SONY', model: 'ILCE-7M4', software: 'Capture One 23 Pro', lens: 'FE 35mm F1.8', focals: [[35, 1]], fnums: [[18, 10], [22, 10], [28, 10]], resolution: 240 },
  { make: 'NIKON CORPORATION', model: 'NIKON Z 6_2', software: 'Adobe Photoshop 25.5 (Windows)', lens: 'NIKKOR Z 50mm f/1.8 S', focals: [[50, 1]], fnums: [[18, 10], [22, 10], [28, 10]], resolution: 300 },
  { make: 'FUJIFILM', model: 'X-T5', software: 'Digital Camera X-T5 Ver1.04', lens: 'XF23mmF1.4 R LM WR', focals: [[23, 1]], fnums: [[14, 10], [20, 10], [28, 10]], resolution: 72 },
  { make: 'Apple', model: 'iPhone 15 Pro', software: '17.4.1', lens: 'iPhone 15 Pro back triple camera 6.765mm f/1.78', focals: [[6765, 1000]], fnums: [[178, 100]], resolution: 72 },
  { make: 'samsung', model: 'SM-S928B', software: 'S928BXXU2AXC7', lens: 'Samsung Galaxy S24 Ultra Rear Wide Camera', focals: [[64, 10]], fnums: [[17, 10]], resolution: 72 }
] as const

const ISO_VALUES = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800] as const
const EXPOSURE_DENOMS = [60, 80, 100, 125, 160, 200, 250, 320, 400, 500] as const

function buildExifBinary(): string {
  const dt = randomDateTime()
  const p = pick(IMAGE_EXIF_PROFILES)
  const { ImageIFD, ExifIFD } = piexif as unknown as {
    ImageIFD: Record<string, number>
    ExifIFD: Record<string, number>
  }
  const exifObj = {
    '0th': {
      [ImageIFD.Make]: p.make,
      [ImageIFD.Model]: p.model,
      [ImageIFD.Software]: p.software,
      [ImageIFD.DateTime]: dt,
      [ImageIFD.XResolution]: [p.resolution, 1],
      [ImageIFD.YResolution]: [p.resolution, 1],
      [ImageIFD.ResolutionUnit]: 2,
      [ImageIFD.Orientation]: 1
    },
    Exif: {
      [ExifIFD.DateTimeOriginal]: dt,
      [ExifIFD.DateTimeDigitized]: dt,
      [ExifIFD.LensModel]: p.lens,
      [ExifIFD.FocalLength]: [...pick(p.focals)],
      [ExifIFD.FNumber]: [...pick(p.fnums)],
      [ExifIFD.ISOSpeedRatings]: pick(ISO_VALUES),
      [ExifIFD.ExposureTime]: [1, pick(EXPOSURE_DENOMS)],
      [ExifIFD.Flash]: 0,
      [ExifIFD.ColorSpace]: 1
    },
    GPS: {},
    '1st': {},
    thumbnail: null
  }
  return (piexif as unknown as { dump: (o: unknown) => string }).dump(exifObj)
}

async function injectExif(jpegPath: string): Promise<void> {
  const data = await fs.readFile(jpegPath)
  const binary = data.toString('binary')
  const exifStr = buildExifBinary()
  const inserted = (piexif as unknown as { insert: (e: string, d: string) => string }).insert(exifStr, binary)
  await fs.writeFile(jpegPath, Buffer.from(inserted, 'binary'))
}

export async function runToTempThenMove(outPath: string, run: (tmpOut: string) => Promise<void>): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), 'bugrette-spoof')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmp = path.join(tmpDir, `${randomUUID()}${path.extname(outPath) || '.bin'}`)
  try {
    await run(tmp)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.copyFile(tmp, outPath)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

// ── Image pipeline ───────────────────────────────────────────────────────────
async function spoofImage(
  srcPath: string,
  outPath: string,
  metaOnly: boolean,
  onProgress?: (p: SpoofProgress) => void
): Promise<void> {
  onProgress?.({ progress: 0.1, label: 'Applying export protection…' })

  const args = ['-y', '-i', srcPath, '-map_metadata', '-1']

  if (!metaOnly) {
    const mean = await meanLuma(srcPath)
    const gamma = exposureGamma(mean, randIn(0.42, 0.45), 0.85, 1.2)
    const angle = randIn(-0.35, 0.35)
    const noise = Math.round(randIn(5, 9))
    const cropK = randIn(0.975, 0.985)
    const rescale = randIn(0.99, 1.005)
    const hue = randIn(-1.5, 1.5)
    const contrast = randIn(1.03, 1.05)
    const saturation = randIn(1.06, 1.1)
    const sharpen = randIn(0.3, 0.5)
    onProgress?.({ progress: 0.4, label: 'Perturbing pixels…' })

    const vf = [
      `noise=alls=${noise}:allf=u`,
      `rotate=${angle.toFixed(4)}*PI/180:ow=iw:oh=ih`,
      `crop=iw*${cropK.toFixed(4)}:ih*${cropK.toFixed(4)}`,
      `scale=trunc(iw*${rescale.toFixed(4)}):trunc(ih*${rescale.toFixed(4)}):flags=lanczos`,
      'curves=all=0/0.02 0.5/0.5 0.8/0.8 1/0.98',
      `hue=h=${hue.toFixed(2)}`,
      `eq=gamma=${gamma.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`,
      `unsharp=3:3:${sharpen.toFixed(2)}`
    ].join(',')
    args.push('-vf', vf)
  }

  const q = String(Math.round(randIn(3, 5)))
  await runToTempThenMove(outPath, async (tmp) => {
    await ffmpegBytes([...args, '-frames:v', '1', '-q:v', q, '-f', 'mjpeg', tmp])
    onProgress?.({ progress: 0.85, label: 'Rebuilding metadata…' })
    await injectExif(tmp)
  })
  onProgress?.({ progress: 1, label: 'Export protection complete' })
}

// ── Video pipeline ───────────────────────────────────────────────────────────
function probeVideoInfo(
  filePath: string
): Promise<{ hasAudio: boolean; duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      FFPROBE_BIN,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { windowsHide: true }
    )
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.on('error', () => resolve({ hasAudio: false, duration: 0, width: 0, height: 0 }))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        const streams: Array<{ codec_type?: string; width?: number; height?: number }> = parsed.streams || []
        const hasAudio = streams.some((s) => s.codec_type === 'audio')
        const v = streams.find((s) => s.codec_type === 'video')
        const duration = Number(parsed.format?.duration) || 0
        resolve({ hasAudio, duration, width: Number(v?.width) || 0, height: Number(v?.height) || 0 })
      } catch {
        resolve({ hasAudio: false, duration: 0, width: 0, height: 0 })
      }
    })
  })
}

async function spoofVideo(
  srcPath: string,
  outPath: string,
  metaOnly: boolean,
  onProgress?: (p: SpoofProgress) => void
): Promise<void> {
  onProgress?.({ progress: 0.05, label: 'Inspecting video…' })

  const { hasAudio, duration, width, height } = await probeVideoInfo(srcPath)
  const mean = await meanLuma(srcPath, duration > 0 ? duration * 0.3 : undefined)
  const gamma = exposureGamma(mean, randIn(0.43, 0.45), 0.88, 1.15)
  const contrast = randIn(1.03, 1.05)
  const saturation = randIn(1.045, 1.075)
  const hue = randIn(-1.2, 1.2)
  const noise = Math.round(randIn(2, 4))
  const cropK = randIn(0.986, 0.995)

  const enhanceVf = [
    'curves=all=0/0.02 0.5/0.5 0.8/0.8 1/0.98',
    `hue=h=${hue.toFixed(2)}`,
    `eq=gamma=${gamma.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`
  ].join(',')

  let vf = enhanceVf
  if (!metaOnly) {
    const cropExpr = `crop=floor(iw*${cropK.toFixed(4)}/2)*2:floor(ih*${cropK.toFixed(4)}/2)*2`
    const geo =
      width > 1 && height > 1
        ? `${cropExpr},scale=${width - (width % 2)}:${height - (height % 2)}:flags=lanczos`
        : cropExpr
    vf = `noise=alls=${noise}:allf=t+u,${geo},${enhanceVf},unsharp=3:3:0.25`
  }

  const prof = pick(VIDEO_DEVICE_PROFILES)
  const isMp4Like = ['.mp4', '.mov', '.m4v'].includes(path.extname(outPath).toLowerCase())

  const args = ['-y']
  if (!metaOnly && duration > 0.5) args.push('-ss', randIn(0.02, 0.08).toFixed(3))
  args.push(
    '-i', srcPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', String(Math.round(randIn(19, 21))),
    '-preset', 'medium',
    '-flags', '+bitexact',
    '-fflags', '+bitexact',
    '-bsf:v', 'filter_units=remove_types=6',
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',
    '-map_metadata:s:a', '-1',
    '-map_chapters', '-1',
    '-metadata', `creation_time=${randomCreationTime()}`,
    '-metadata:s:v', `handler_name=${prof.vHandler}`
  )
  if (isMp4Like) {
    args.push(
      '-metadata', `make=${prof.make}`,
      '-metadata', `model=${prof.model}`,
      '-video_track_timescale', String(pick(VIDEO_TIMESCALES)),
      '-movflags', '+faststart+use_metadata_tags'
    )
  }
  if (hasAudio) {
    args.push('-metadata:s:a', `handler_name=${prof.aHandler}`, '-c:a', 'aac', '-b:a', '320k')
    if (!metaOnly) args.push('-af', `volume=${randIn(0.97, 1.03).toFixed(3)}`)
  } else args.push('-an')
  args.push('-progress', 'pipe:1', '-nostats')

  await runToTempThenMove(outPath, (tmpOut) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG_BIN, [...args, tmpOut], { windowsHide: true })
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const m = /^out_time_us=(\d+)/.exec(line.trim())
          if (m && duration > 0) {
            const secs = Number(m[1]) / 1_000_000
            const frac = clamp(0.1 + (secs / duration) * 0.85, 0.1, 0.95)
            onProgress?.({ progress: frac, label: 'Re-encoding with protection…' })
          }
        }
      })
      child.stderr.on('data', (c) => (stderr += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().slice(-400) || `Spoofer re-encode failed (exit ${code}).`))
      })
    })
  )

  if (isMp4Like) await patchCompressorName(outPath, prof.compressor)

  onProgress?.({ progress: 1, label: 'Export protection complete' })
}

async function patchCompressorName(filePath: string, replacement: string): Promise<void> {
  try {
    const buf = await fs.readFile(filePath)
    const marker = Buffer.concat([Buffer.from([0x0c]), Buffer.from('Lavc libx264', 'latin1')])
    const idx = buf.indexOf(marker)
    if (idx === -1) return
    const rep = Buffer.from(replacement.slice(0, 31), 'latin1')
    const field = Buffer.alloc(marker.length)
    field[0] = rep.length
    rep.copy(field, 1)
    field.copy(buf, idx)
    await fs.writeFile(filePath, buf)
  } catch {
    // Non-fatal cosmetic cleanup.
  }
}

export function exportStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export async function ensureWritableFolder(preferred: string): Promise<string> {
  const candidates: string[] = [(preferred || '').trim()]
  try {
    candidates.push(app.getPath('videos'))
  } catch {
    // no Videos folder
  }
  try {
    candidates.push(path.join(app.getPath('downloads'), 'Bugrette'))
  } catch {
    // no Downloads folder
  }
  candidates.push(path.join(os.tmpdir(), 'bugrette-exports'))

  for (const dir of candidates) {
    if (!dir) continue
    try {
      await fs.mkdir(dir, { recursive: true })
      const probe = path.join(dir, `.write-probe-${randomUUID()}`)
      await fs.writeFile(probe, 'ok')
      await fs.rm(probe, { force: true })
      return dir
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`The output folder "${preferred}" is not writable. Choose a different folder in the dashboard.`)
}

export async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const stem = path.basename(fileName, ext) || 'export'
  let candidate = path.join(dir, `${stem}-${exportStamp()}${ext}`)
  let n = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(dir, `${stem}-${exportStamp()}-${n++}${ext}`)
    } catch {
      return candidate
    }
  }
}

/**
 * Run export protection on a source file and write the result into `outDir`
 * (the source is left untouched). Returns the output path and detected media
 * type. Images become a perturbed JPEG with rebuilt EXIF; videos are
 * re-encoded with metadata stripped and subtle anti-fingerprint noise.
 */
export async function spoofToFolder(
  srcPath: string,
  outDir: string,
  onProgress?: (p: SpoofProgress) => void,
  baseName?: string
): Promise<{ path: string; type: 'video' | 'image' | 'other' }> {
  const cfg = getConfig()
  const metaOnly = cfg.spooferMetaOnly
  outDir = await ensureWritableFolder(outDir)
  const ext = path.extname(srcPath).toLowerCase()
  const isImage = IMAGE_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  const stem =
    (baseName ? baseName.replace(/\.[^.]+$/, '') : path.basename(srcPath, path.extname(srcPath))) || 'spoofed'

  if (!cfg.spooferEnabled) {
    const dest = await uniquePath(outDir, `${stem}${ext || ''}`)
    await fs.copyFile(srcPath, dest)
    onProgress?.({ progress: 1, label: 'Spoofer is off — file copied unchanged' })
    return { path: dest, type: isImage ? 'image' : isVideo ? 'video' : 'other' }
  }

  if (isImage) {
    const dest = await uniquePath(outDir, `${stem}-spoofed.jpg`)
    await spoofImage(srcPath, dest, metaOnly, onProgress)
    return { path: dest, type: 'image' }
  }
  if (isVideo) {
    const dest = await uniquePath(outDir, `${stem}-spoofed${ext || '.mp4'}`)
    await spoofVideo(srcPath, dest, metaOnly, onProgress)
    return { path: dest, type: 'video' }
  }

  const dest = await uniquePath(outDir, path.basename(srcPath))
  await fs.copyFile(srcPath, dest)
  onProgress?.({ progress: 1, label: 'Copied (unsupported type)' })
  return { path: dest, type: 'other' }
}

export function isSpoofableExt(ext: string): boolean {
  const e = ext.toLowerCase()
  return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e)
}
