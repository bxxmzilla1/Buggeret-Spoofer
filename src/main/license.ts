import { randomBytes } from 'node:crypto'
import type { License } from '@shared/types'
import { getConfig, getLicense, upsertLicense } from './store'

// License keys look like BUGR-XXXX-XXXX-XXXX-XXXX using an unambiguous alphabet
// (no 0/O/1/I) so they are easy to copy/paste from a Telegram message.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomGroup(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

export function generateLicenseKey(): string {
  let key = ''
  do {
    key = `BUGR-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`
  } while (getLicense(key)) // avoid the astronomically unlikely collision
  return key
}

/**
 * Create a license reserved for a specific Telegram @username. Only a user
 * whose username matches can activate it. This is the sole way licenses are
 * issued now (the crypto payment flow has been removed).
 */
export function createAssignedLicense(rawUsername: string): License {
  const username = normalizeUsername(rawUsername)
  const license: License = {
    key: generateLicenseKey(),
    status: 'assigned',
    createdAt: Date.now(),
    assignedUsername: username,
    admins: []
  }
  upsertLicense(license)
  return license
}

export type ActivateResult =
  | { ok: true; license: License }
  | {
      ok: false
      reason: 'not-found' | 'revoked' | 'expired' | 'used-by-other' | 'unpaid' | 'wrong-user' | 'no-username'
    }

/**
 * Bind an assigned license to the Telegram account that claims it. Succeeds
 * only when the caller's @username matches the license's `assignedUsername`.
 * Idempotent for the same owner (re-sending the key just returns the license).
 */
export function activateLicense(key: string, telegramId: number, username?: string): ActivateResult {
  const license = getLicense(key.trim().toUpperCase())
  if (!license) return { ok: false, reason: 'not-found' }
  if (license.status === 'revoked') return { ok: false, reason: 'revoked' }
  if (license.status === 'expired') return { ok: false, reason: 'expired' }
  if (license.status === 'unpaid') return { ok: false, reason: 'unpaid' }

  // Already activated?
  if (license.ownerTelegramId) {
    if (license.ownerTelegramId === telegramId) return { ok: true, license }
    return { ok: false, reason: 'used-by-other' }
  }

  // Enforce the username assignment. Fail closed: an assigned key with no
  // recorded username (should not happen) is rejected rather than opened up.
  const caller = (username || '').toLowerCase()
  const assigned = (license.assignedUsername || '').toLowerCase()
  if (assigned) {
    if (!caller) return { ok: false, reason: 'no-username' }
    if (caller !== assigned) return { ok: false, reason: 'wrong-user' }
  } else if (license.status === 'assigned') {
    return { ok: false, reason: 'wrong-user' }
  }

  const days = getConfig().subscriptionDays
  const now = Date.now()
  const activated: License = {
    ...license,
    status: 'active',
    ownerTelegramId: telegramId,
    ownerUsername: caller || undefined,
    activatedAt: now,
    expiresAt: now + days * 24 * 60 * 60 * 1000
  }
  upsertLicense(activated)
  return { ok: true, license: activated }
}

export type AdminResult =
  | { ok: true; license: License }
  | { ok: false; reason: 'full' | 'duplicate' | 'invalid' | 'not-owner' | 'is-owner' }

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase()
}

export function addAdmin(license: License, rawUsername: string): AdminResult {
  const username = normalizeUsername(rawUsername)
  if (!/^[a-z0-9_]{4,32}$/.test(username)) return { ok: false, reason: 'invalid' }
  if (username === (license.ownerUsername || '')) return { ok: false, reason: 'is-owner' }
  if (license.admins.some((a) => a.username === username)) return { ok: false, reason: 'duplicate' }
  const max = getConfig().maxAdmins
  if (license.admins.length >= max) return { ok: false, reason: 'full' }

  const updated: License = { ...license, admins: [...license.admins, { username }] }
  upsertLicense(updated)
  return { ok: true, license: updated }
}

export function removeAdmin(license: License, rawUsername: string): License {
  const username = normalizeUsername(rawUsername)
  const updated: License = { ...license, admins: license.admins.filter((a) => a.username !== username) }
  upsertLicense(updated)
  return updated
}
