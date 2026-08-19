import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

// Resolve the bundled ffmpeg/ffprobe binaries so the spoofer never depends on a
// system install. In a packaged app the binaries are unpacked from the asar
// archive (see electron-builder.yml `asarUnpack`), so app.asar paths are
// rewritten to app.asar.unpacked and cached into a stable userData folder.

function unpackedPath(p: string): string {
  return p
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    .replace('app.asar/', 'app.asar.unpacked/')
}

function stableBinDir(): string {
  try {
    return path.join(app.getPath('userData'), 'bin')
  } catch {
    return path.join(os.tmpdir(), 'bugrette-bin')
  }
}

function isRealBinary(p: string): boolean {
  try {
    return fsSync.existsSync(p) && fsSync.statSync(p).size > 1_000_000
  } catch {
    return false
  }
}

function resolveBinary(rawPath: string | null | undefined, exeName: string): string {
  if (!rawPath) throw new Error('Bundled ffmpeg/ffprobe binary path is unavailable.')

  const primary = unpackedPath(rawPath)
  const candidates = [primary, rawPath]
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', exeName))

  let packaged = false
  try {
    packaged = app.isPackaged
  } catch {
    packaged = false
  }

  if (!packaged) {
    for (const c of candidates) if (isRealBinary(c)) return c
    return primary
  }

  const stable = path.join(stableBinDir(), exeName)
  if (isRealBinary(stable)) return stable

  for (const c of candidates) {
    if (!isRealBinary(c)) continue
    try {
      fsSync.mkdirSync(path.dirname(stable), { recursive: true })
      fsSync.copyFileSync(c, stable)
      return stable
    } catch {
      return c
    }
  }
  return primary
}

const isWin = process.platform === 'win32'
export const FFMPEG_BIN = resolveBinary(ffmpegStatic as unknown as string, isWin ? 'ffmpeg.exe' : 'ffmpeg')
export const FFPROBE_BIN = resolveBinary(
  (ffprobeStatic as { path: string }).path,
  isWin ? 'ffprobe.exe' : 'ffprobe'
)

/** Run the bundled ffmpeg with arbitrary args, returning nothing on success. */
export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'ENOENT') {
        reject(
          new Error(
            `${path.basename(FFMPEG_BIN)} is missing. Antivirus may have removed the bundled video tools — restore it from quarantine or add an exclusion.`
          )
        )
        return
      }
      reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-400)}`))
    })
  })
}
