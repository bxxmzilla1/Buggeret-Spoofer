import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getConfig } from './store'
import { getSupabaseClient, getTokenTelegramId, isSupabaseConfigured } from './supabase'
import { spoofToFolder } from './spoofer'
import { sendMessage } from './tg'

// Web bulk-upload pipeline (Architecture A). A remote user uploads many files
// through a static web page straight into Supabase Storage and inserts a job
// row; this worker (running on the 24/7 PC) claims queued jobs, spoofs each
// file with the same engine the bot uses, uploads the results back to Storage,
// stores time-limited signed download URLs on the job row, then auto-deletes
// the uploaded inputs immediately and the outputs after the retention window.

const UPLOAD_BUCKET = 'spoof-uploads'
const OUTPUT_BUCKET = 'spoof-outputs'
const STALE_PROCESSING_MS = 10 * 60 * 1000 // requeue a job stuck "processing" this long

interface JobFile {
  name: string
  size?: number
  status?: 'pending' | 'done' | 'error'
  outName?: string
  downloadUrl?: string
  error?: string
}

interface JobRow {
  job_id: string
  license_key: string | null
  upload_token: string | null
  telegram_id: number | null
  status: 'queued' | 'processing' | 'done' | 'error'
  total: number
  completed: number
  files: JobFile[]
  error: string | null
  created_at: number
  updated_at: number
  expires_at: number | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let workerStarted = false

export function startJobWorker(): void {
  if (workerStarted) return
  workerStarted = true
  void (async () => {
    for (;;) {
      await sleep(8000)
      try {
        await tick()
      } catch (err) {
        console.warn('[jobs] worker tick failed:', err instanceof Error ? err.message : err)
      }
    }
  })()
}

async function tick(): Promise<void> {
  const cfg = getConfig()
  if (!cfg.webIntakeEnabled || !isSupabaseConfigured()) return
  const c = getSupabaseClient()
  if (!c) return

  await cleanupExpired(c)
  await requeueStale(c)

  const { data, error } = await c
    .from('spoof_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw error
  const job = (data as JobRow[])?.[0]
  if (!job) return

  await processJob(c, job)
}

/** Claim a queued job, spoof each file, upload results, then finalize. */
async function processJob(c: SupabaseClient, job: JobRow): Promise<void> {
  const cfg = getConfig()

  // Optimistic claim: only proceed if the row is still queued.
  const claim = await c
    .from('spoof_jobs')
    .update({ status: 'processing', updated_at: Date.now() })
    .eq('job_id', job.job_id)
    .eq('status', 'queued')
    .select('job_id')
  if (claim.error) throw claim.error
  if (!claim.data || claim.data.length === 0) return // someone/something else took it

  const workDir = path.join(os.tmpdir(), 'bugrette-jobs', job.job_id)
  await fs.mkdir(workDir, { recursive: true })

  const files = Array.isArray(job.files) ? job.files.slice() : []
  let completed = 0

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const inPath = `${job.job_id}/${file.name}`
        const localIn = path.join(workDir, file.name)

        // Download the uploaded input.
        const dl = await c.storage.from(UPLOAD_BUCKET).download(inPath)
        if (dl.error || !dl.data) throw new Error(dl.error?.message || 'download failed')
        const buf = Buffer.from(await dl.data.arrayBuffer())
        await fs.writeFile(localIn, buf)

        // Spoof into the PC's output folder (keeps a local copy too).
        const result = await spoofToFolder(localIn, cfg.outputFolder, undefined, file.name)
        const outName = path.basename(result.path)

        // Upload the spoofed result and mint a signed download URL.
        const outData = await fs.readFile(result.path)
        const outPath = `${job.job_id}/${outName}`
        const up = await c.storage
          .from(OUTPUT_BUCKET)
          .upload(outPath, outData, { contentType: contentTypeFor(outName), upsert: true })
        if (up.error) throw up.error

        const expiresIn = Math.max(3600, cfg.jobRetentionHours * 3600)
        const signed = await c.storage.from(OUTPUT_BUCKET).createSignedUrl(outPath, expiresIn)
        if (signed.error || !signed.data) throw new Error(signed.error?.message || 'sign failed')

        files[i] = { ...file, status: 'done', outName, downloadUrl: signed.data.signedUrl }
      } catch (err) {
        files[i] = { ...file, status: 'error', error: err instanceof Error ? err.message : String(err) }
      }

      completed++
      // Push incremental progress so the web page updates live.
      await c
        .from('spoof_jobs')
        .update({ completed, files, updated_at: Date.now() })
        .eq('job_id', job.job_id)
    }

    const now = Date.now()
    const anyOk = files.some((f) => f.status === 'done')
    await c
      .from('spoof_jobs')
      .update({
        status: 'done',
        completed,
        files,
        updated_at: now,
        expires_at: now + Math.max(1, cfg.jobRetentionHours) * 3600 * 1000,
        error: anyOk ? null : 'All files failed to process.'
      })
      .eq('job_id', job.job_id)

    // Inputs are no longer needed — delete them right away to save storage.
    await removeAll(c, UPLOAD_BUCKET, files.map((f) => `${job.job_id}/${f.name}`))

    await notify(job, files)
  } catch (err) {
    await c
      .from('spoof_jobs')
      .update({ status: 'error', error: err instanceof Error ? err.message : String(err), updated_at: Date.now() })
      .eq('job_id', job.job_id)
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** DM the requester (resolved from the upload token) with the download links. */
async function notify(job: JobRow, files: JobFile[]): Promise<void> {
  const cfg = getConfig()
  if (!cfg.botToken.trim()) return
  // The temporary token records who requested the link; fall back to any
  // telegram_id stored on the job (legacy jobs).
  const chatId = job.upload_token
    ? await getTokenTelegramId(job.upload_token)
    : job.telegram_id
  if (!chatId) return
  const links = files
    .filter((f) => f.downloadUrl)
    .map((f, i) => `${i + 1}. <a href="${f.downloadUrl}">${escapeHtml(f.outName || f.name)}</a>`)
    .join('\n')
  const text = links
    ? `✅ Your bulk spoof job is ready (${files.filter((f) => f.status === 'done').length}/${files.length}):\n\n${links}\n\nLinks expire in ${cfg.jobRetentionHours}h.`
    : '❌ Your bulk spoof job failed to process any files.'
  await sendMessage(cfg.botToken.trim(), chatId, text).catch(() => {})
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupExpired(c: SupabaseClient): Promise<void> {
  const now = Date.now()
  const { data, error } = await c
    .from('spoof_jobs')
    .select('job_id, files')
    .lt('expires_at', now)
    .not('expires_at', 'is', null)
  if (error || !data) return
  for (const row of data as Array<{ job_id: string; files: JobFile[] }>) {
    const outPaths = (row.files || []).filter((f) => f.outName).map((f) => `${row.job_id}/${f.outName}`)
    await removeAll(c, OUTPUT_BUCKET, outPaths)
    await removeAll(c, UPLOAD_BUCKET, (row.files || []).map((f) => `${row.job_id}/${f.name}`))
    await c.from('spoof_jobs').delete().eq('job_id', row.job_id)
  }

  // Purge upload tokens well past their expiry (grace window lets in-flight
  // jobs still resolve their requester for the DM).
  await c
    .from('upload_tokens')
    .delete()
    .lt('expires_at', now - 60 * 60 * 1000)
    .then(undefined, () => {})
}

async function requeueStale(c: SupabaseClient): Promise<void> {
  const cutoff = Date.now() - STALE_PROCESSING_MS
  await c
    .from('spoof_jobs')
    .update({ status: 'queued', updated_at: Date.now() })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
}

async function removeAll(c: SupabaseClient, bucket: string, paths: string[]): Promise<void> {
  const clean = paths.filter(Boolean)
  if (!clean.length) return
  try {
    await c.storage.from(bucket).remove(clean)
  } catch {
    // best-effort cleanup
  }
}

function contentTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska'
  }
  return map[ext] || 'application/octet-stream'
}
