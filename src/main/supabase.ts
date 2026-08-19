import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { License } from '@shared/types'
import { allLicenses, getConfig, mergeLicensesLocal, setLicenseSyncHooks } from './store'

// Durable store for users (license owners) and admins in Supabase. The local
// electron-store stays the fast, synchronous source of truth the bot reads on
// every update; every license change is mirrored to Supabase (fire-and-forget)
// and, on startup, Supabase is treated as authoritative and loaded back in.
//
// Two tables are used (see supabase/schema.sql):
//   licenses(key, status, created_at, activated_at, expires_at,
//            owner_telegram_id, owner_username, payment_id, pay_currency)
//   admins(license_key, username, telegram_id)

let client: SupabaseClient | null = null
let clientSignature = ''

function isConfigured(): boolean {
  const cfg = getConfig()
  return cfg.supabaseUrl.trim().length > 0 && cfg.supabaseKey.trim().length > 0
}

function getClient(): SupabaseClient | null {
  if (!isConfigured()) {
    client = null
    clientSignature = ''
    return null
  }
  const cfg = getConfig()
  const sig = `${cfg.supabaseUrl}::${cfg.supabaseKey}`
  if (!client || sig !== clientSignature) {
    client = createClient(cfg.supabaseUrl.trim(), cfg.supabaseKey.trim(), {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    clientSignature = sig
  }
  return client
}

// ── Row mapping ──────────────────────────────────────────────────────────────

interface LicenseRow {
  key: string
  status: string
  created_at: number
  assigned_username: string | null
  activated_at: number | null
  expires_at: number | null
  owner_telegram_id: number | null
  owner_username: string | null
  payment_id: string | null
  pay_currency: string | null
}

interface AdminRow {
  license_key: string
  username: string
  telegram_id: number | null
}

function toLicenseRow(l: License): LicenseRow {
  return {
    key: l.key,
    status: l.status,
    created_at: l.createdAt,
    assigned_username: l.assignedUsername ?? null,
    activated_at: l.activatedAt ?? null,
    expires_at: l.expiresAt ?? null,
    owner_telegram_id: l.ownerTelegramId ?? null,
    owner_username: l.ownerUsername ?? null,
    payment_id: l.paymentId ?? null,
    pay_currency: l.payCurrency ?? null
  }
}

function fromRows(licenseRow: LicenseRow, adminRows: AdminRow[]): License {
  return {
    key: licenseRow.key,
    status: licenseRow.status as License['status'],
    createdAt: Number(licenseRow.created_at) || Date.now(),
    assignedUsername: licenseRow.assigned_username ?? undefined,
    activatedAt: licenseRow.activated_at ?? undefined,
    expiresAt: licenseRow.expires_at ?? undefined,
    ownerTelegramId: licenseRow.owner_telegram_id ?? undefined,
    ownerUsername: licenseRow.owner_username ?? undefined,
    paymentId: licenseRow.payment_id ?? undefined,
    payCurrency: licenseRow.pay_currency ?? undefined,
    admins: adminRows
      .filter((a) => a.license_key === licenseRow.key)
      .map((a) => ({ username: a.username, telegramId: a.telegram_id ?? undefined }))
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function upsertLicenseRow(license: License): Promise<void> {
  const c = getClient()
  if (!c) return
  try {
    const { error: licErr } = await c.from('licenses').upsert(toLicenseRow(license), { onConflict: 'key' })
    if (licErr) throw licErr

    // Replace this license's admins so removals propagate too.
    const { error: delErr } = await c.from('admins').delete().eq('license_key', license.key)
    if (delErr) throw delErr

    if (license.admins.length) {
      const rows: AdminRow[] = license.admins.map((a) => ({
        license_key: license.key,
        username: a.username,
        telegram_id: a.telegramId ?? null
      }))
      const { error: insErr } = await c.from('admins').insert(rows)
      if (insErr) throw insErr
    }
  } catch (err) {
    console.warn('[supabase] license upsert failed:', err instanceof Error ? err.message : err)
  }
}

async function deleteLicenseRow(key: string): Promise<void> {
  const c = getClient()
  if (!c) return
  try {
    await c.from('admins').delete().eq('license_key', key)
    await c.from('licenses').delete().eq('key', key)
  } catch (err) {
    console.warn('[supabase] license delete failed:', err instanceof Error ? err.message : err)
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function loadAll(): Promise<License[]> {
  const c = getClient()
  if (!c) return []
  const { data: licenseRows, error: licErr } = await c.from('licenses').select('*')
  if (licErr) throw licErr
  const { data: adminRows, error: admErr } = await c.from('admins').select('*')
  if (admErr) throw admErr
  return (licenseRows as LicenseRow[]).map((row) => fromRows(row, (adminRows as AdminRow[]) || []))
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Register the sync hooks and reconcile with Supabase:
 *  - pull every license/admin from Supabase into the local cache (DB wins);
 *  - push any local-only licenses up so nothing created offline is lost.
 * Safe to call repeatedly (e.g. after the operator changes the credentials).
 */
export async function initSupabase(): Promise<void> {
  setLicenseSyncHooks({
    upsert: (license) => void upsertLicenseRow(license),
    remove: (key) => void deleteLicenseRow(key)
  })

  if (!isConfigured()) return
  try {
    const localBefore = allLicenses()
    const db = await loadAll()
    const dbKeys = new Set(db.map((l) => l.key))

    if (db.length) mergeLicensesLocal(db)

    const localOnly = localBefore.filter((l) => !dbKeys.has(l.key))
    for (const l of localOnly) await upsertLicenseRow(l)

    console.log(
      `[supabase] connected — ${db.length} licenses loaded, ${localOnly.length} local-only pushed.`
    )
  } catch (err) {
    console.warn('[supabase] initial sync failed:', err instanceof Error ? err.message : err)
  }
}

/** Re-create the client (credentials changed) and reconcile again. */
export async function reinitSupabase(): Promise<void> {
  client = null
  clientSignature = ''
  await initSupabase()
}

export function isSupabaseConfigured(): boolean {
  return isConfigured()
}

/** Shared client for other main-process modules (e.g. the job worker). */
export function getSupabaseClient(): SupabaseClient | null {
  return getClient()
}

/**
 * Mint a temporary upload token (default 30 min) for the web bulk-upload page.
 * Returns the token string, or null if Supabase isn't configured / the insert
 * failed. Uses the service_role client, so it bypasses RLS.
 */
export async function createUploadToken(
  telegramId: number,
  ttlMinutes = 30
): Promise<string | null> {
  const c = getClient()
  if (!c) return null
  const token = randomUUID()
  const now = Date.now()
  try {
    const { error } = await c.from('upload_tokens').insert({
      token,
      telegram_id: telegramId,
      created_at: now,
      expires_at: now + ttlMinutes * 60 * 1000
    })
    if (error) {
      console.warn('[supabase] createUploadToken failed:', error.message)
      return null
    }
  } catch (err) {
    console.warn('[supabase] createUploadToken threw:', err instanceof Error ? err.message : err)
    return null
  }
  return token
}

/** Look up which Telegram user requested a given upload token (for DM delivery). */
export async function getTokenTelegramId(token: string): Promise<number | null> {
  const c = getClient()
  if (!c || !token) return null
  const { data, error } = await c
    .from('upload_tokens')
    .select('telegram_id')
    .eq('token', token)
    .maybeSingle()
  if (error || !data) return null
  return (data as { telegram_id: number | null }).telegram_id ?? null
}
