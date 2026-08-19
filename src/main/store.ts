import { app } from 'electron'
import Store from 'electron-store'
import type {
  BotConfig,
  ConfigPatch,
  License,
  LicenseView,
  PendingPayment,
  PublicConfig
} from '@shared/types'

// All state — bot token, NowPayments key, issued licenses, admins and pending
// crypto payments — lives here in the main process, persisted with
// electron-store in the app's userData folder. Secret keys are never sent to
// the renderer (only the masked PublicConfig).

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULTS: BotConfig = {
  botToken: '',
  nowPaymentsApiKey: '',
  ipnSecret: '',
  supabaseUrl: '',
  supabaseKey: '',
  outputFolder: '',
  spooferEnabled: true,
  spooferMetaOnly: false,
  priceUsd: 200,
  subscriptionDays: 30,
  maxAdmins: 5,
  payCurrencies: ['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'sol', 'trx', 'bnbbsc'],
  webIntakeEnabled: false,
  uploadPageUrl: '',
  jobRetentionHours: 24,
  maxUploadMb: 200,
  licenses: {},
  pendingPayments: {},
  lastUpdateId: 0
}

let store: Store<BotConfig> | null = null

function getStore(): Store<BotConfig> {
  if (!store) {
    store = new Store<BotConfig>({
      name: 'bugrette-spoofer-config',
      defaults: DEFAULTS,
      cwd: app.getPath('userData')
    })
  }
  return store
}

export function getConfig(): BotConfig {
  const s = getStore()
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof BotConfig)[]) {
    // @ts-expect-error indexed assignment across union value types
    out[key] = s.get(key, DEFAULTS[key])
  }
  if (!out.outputFolder) {
    try {
      out.outputFolder = app.getPath('videos') || app.getPath('downloads')
    } catch {
      out.outputFolder = ''
    }
  }
  return out
}

export function saveConfig(patch: ConfigPatch): PublicConfig {
  const s = getStore()
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    s.set(k as keyof BotConfig, v as never)
  }
  return toPublicConfig(getConfig())
}

export function toPublicConfig(cfg: BotConfig): PublicConfig {
  return {
    hasBotToken: cfg.botToken.trim().length > 0,
    hasNowPaymentsKey: cfg.nowPaymentsApiKey.trim().length > 0,
    hasIpnSecret: cfg.ipnSecret.trim().length > 0,
    supabaseUrl: cfg.supabaseUrl,
    hasSupabaseKey: cfg.supabaseKey.trim().length > 0,
    outputFolder: cfg.outputFolder,
    spooferEnabled: cfg.spooferEnabled,
    spooferMetaOnly: cfg.spooferMetaOnly,
    priceUsd: cfg.priceUsd,
    subscriptionDays: cfg.subscriptionDays,
    maxAdmins: cfg.maxAdmins,
    payCurrencies: cfg.payCurrencies,
    webIntakeEnabled: cfg.webIntakeEnabled,
    uploadPageUrl: cfg.uploadPageUrl,
    jobRetentionHours: cfg.jobRetentionHours,
    maxUploadMb: cfg.maxUploadMb
  }
}

// ── Licenses ─────────────────────────────────────────────────────────────────

// Sync hooks let the Supabase mirror observe license changes without creating
// an import cycle (store <-> supabase). They are registered at startup and are
// fire-and-forget; a Supabase outage never blocks the local store.
type LicenseHook = (license: License) => void
type DeleteHook = (key: string) => void
let onLicenseUpsert: LicenseHook | null = null
let onLicenseDelete: DeleteHook | null = null

export function setLicenseSyncHooks(hooks: { upsert?: LicenseHook; remove?: DeleteHook }): void {
  if (hooks.upsert) onLicenseUpsert = hooks.upsert
  if (hooks.remove) onLicenseDelete = hooks.remove
}

export function getLicense(key: string): License | undefined {
  return getConfig().licenses[key]
}

export function upsertLicense(license: License, opts?: { sync?: boolean }): void {
  const s = getStore()
  const licenses = { ...getConfig().licenses, [license.key]: license }
  s.set('licenses', licenses)
  if (opts?.sync !== false) onLicenseUpsert?.(license)
}

export function deleteLicense(key: string): void {
  const s = getStore()
  const licenses = { ...getConfig().licenses }
  delete licenses[key]
  s.set('licenses', licenses)
  onLicenseDelete?.(key)
}

/** Bulk write licenses into the local cache WITHOUT re-triggering sync hooks. */
export function mergeLicensesLocal(licenses: License[]): void {
  const s = getStore()
  const map = { ...getConfig().licenses }
  for (const l of licenses) map[l.key] = l
  s.set('licenses', map)
}

export function allLicenses(): License[] {
  return Object.values(getConfig().licenses)
}

/** Refresh derived status (active/expired) based on expiry and return the row. */
export function reconcileLicense(license: License): License {
  if (license.status === 'revoked' || license.status === 'unpaid') return license
  if (license.activatedAt && license.expiresAt) {
    const nowExpired = Date.now() > license.expiresAt
    const status: License['status'] = nowExpired ? 'expired' : 'active'
    if (status !== license.status) {
      const updated = { ...license, status }
      upsertLicense(updated)
      return updated
    }
  }
  return license
}

export function toLicenseView(license: License): LicenseView {
  const reconciled = reconcileLicense(license)
  let daysLeft: number | null = null
  if (reconciled.expiresAt) {
    daysLeft = Math.max(0, Math.ceil((reconciled.expiresAt - Date.now()) / DAY_MS))
  }
  return { ...reconciled, daysLeft }
}

/**
 * Resolve access for a Telegram user. Returns an ACTIVE license where the user
 * is the owner or one of the admins (matched by @username, then bound to their
 * numeric id on first contact). Returns null when the user has no access.
 */
export function findAccessLicense(
  telegramId: number,
  username?: string
): { license: License; role: 'owner' | 'admin' } | null {
  const uname = (username || '').toLowerCase()
  for (const raw of allLicenses()) {
    const license = reconcileLicense(raw)
    if (license.status !== 'active') continue

    if (license.ownerTelegramId === telegramId) return { license, role: 'owner' }

    const adminIdx = license.admins.findIndex(
      (a) => (a.telegramId && a.telegramId === telegramId) || (uname && a.username === uname)
    )
    if (adminIdx >= 0) {
      const admin = license.admins[adminIdx]
      if (uname && admin.telegramId !== telegramId) {
        // Bind the id the first time this admin messages the bot.
        const admins = license.admins.slice()
        admins[adminIdx] = { ...admin, telegramId }
        upsertLicense({ ...license, admins })
      }
      return { license, role: 'admin' }
    }
  }
  return null
}

/** The active license owned by a given Telegram user (for the admin menu). */
export function findOwnedLicense(telegramId: number): License | null {
  for (const raw of allLicenses()) {
    const license = reconcileLicense(raw)
    if (license.ownerTelegramId === telegramId && license.status === 'active') return license
  }
  return null
}

// ── Pending payments ─────────────────────────────────────────────────────────

export function upsertPending(p: PendingPayment): void {
  const s = getStore()
  const pending = { ...getConfig().pendingPayments, [p.paymentId]: p }
  s.set('pendingPayments', pending)
}

export function deletePending(paymentId: string): void {
  const s = getStore()
  const pending = { ...getConfig().pendingPayments }
  delete pending[paymentId]
  s.set('pendingPayments', pending)
}

export function allPending(): PendingPayment[] {
  return Object.values(getConfig().pendingPayments)
}

export function getPending(paymentId: string): PendingPayment | undefined {
  return getConfig().pendingPayments[paymentId]
}

// ── Poll offset ──────────────────────────────────────────────────────────────

export function getLastUpdateId(): number {
  return getConfig().lastUpdateId
}

export function setLastUpdateId(id: number): void {
  getStore().set('lastUpdateId', id)
}
