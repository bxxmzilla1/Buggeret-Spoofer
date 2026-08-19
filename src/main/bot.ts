import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { BotStatus, PendingPayment } from '@shared/types'
import { APP_NAME } from '@shared/types'
import {
  answerCallback,
  downloadFile,
  editMessage,
  escapeHtml,
  getMe,
  getUpdates,
  sendDocument,
  sendMessage,
  setMyCommands,
  TgApiError,
  type InlineKeyboard,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
  type TgUser
} from './tg'
import {
  getConfig,
  getLastUpdateId,
  setLastUpdateId,
  findAccessLicense,
  findOwnedLicense,
  upsertPending,
  deletePending,
  allPending
} from './store'
import { activateLicense, addAdmin, createUnpaidLicense, markLicensePaid, removeAdmin } from './license'
import {
  createPayment,
  getPaymentStatus,
  isDead,
  isPaid,
  NowPaymentsError,
  statusLabel
} from './payments'
import { isSpoofableExt, spoofToFolder } from './spoofer'

// The Telegram bot for Bugrette Spoofer. One long-poll loop drives everything;
// all user actions happen through inline-keyboard menus. Access to the spoofer
// is gated behind an active subscription license (owner + up to 5 admins).

// ── Runtime status (surfaced to the dashboard) ───────────────────────────────
let botStatus: BotStatus = { state: 'idle' }
let statusListeners: Array<(s: BotStatus) => void> = []

export function getBotStatus(): BotStatus {
  return botStatus
}

export function onBotStatus(cb: (s: BotStatus) => void): () => void {
  statusListeners.push(cb)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== cb)
  }
}

function setStatus(s: BotStatus): void {
  botStatus = s
  for (const l of statusListeners) l(s)
}

// ── Per-chat conversational state (in memory) ────────────────────────────────
type Mode = 'idle' | 'await_license' | 'await_admin_add'
interface Session {
  mode: Mode
}
const sessions = new Map<number, Session>()
function session(chatId: number): Session {
  let s = sessions.get(chatId)
  if (!s) {
    s = { mode: 'idle' }
    sessions.set(chatId, s)
  }
  return s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Menus ────────────────────────────────────────────────────────────────────

function priceLabel(): string {
  const cfg = getConfig()
  return `$${cfg.priceUsd}/month`
}

function mainMenuText(user: TgUser, access: ReturnType<typeof findAccessLicense>): string {
  const name = escapeHtml(user.first_name || user.username || 'there')
  if (access) {
    const role = access.role === 'owner' ? 'owner' : 'admin'
    return (
      `🐞 <b>${APP_NAME}</b>\n\n` +
      `Welcome back, ${name} — you have <b>${role}</b> access.\n\n` +
      `Send me any <b>image</b> or <b>video</b> and I'll spoof it (strip fingerprints, rebuild metadata) and send it back. ` +
      `Or pick an option below.`
    )
  }
  return (
    `🐞 <b>${APP_NAME}</b>\n\n` +
    `Hi ${name}! I spoof images & videos so no two exports share a fingerprint.\n\n` +
    `Access requires a subscription of <b>${priceLabel()}</b>, paid in crypto. ` +
    `After payment you get a license key to activate on your account.`
  )
}

function mainMenuKeyboard(user: TgUser, access: ReturnType<typeof findAccessLicense>): InlineKeyboard {
  if (access) {
    const rows: InlineKeyboard = [
      [{ text: '🛡 Spoof media', callback_data: 'spoof_help' }],
      [{ text: '📊 My subscription', callback_data: 'sub_info' }]
    ]
    if (access.role === 'owner') rows.push([{ text: '👥 Manage admins', callback_data: 'admins' }])
    // Bulk web upload — owner only (the link carries the license key). Requires
    // web intake enabled and a hosted upload page URL configured in Settings.
    const cfg = getConfig()
    if (access.role === 'owner' && cfg.webIntakeEnabled && cfg.uploadPageUrl.trim()) {
      const url = `${cfg.uploadPageUrl.trim()}#key=${encodeURIComponent(access.license.key)}`
      rows.push([{ text: '🌐 Bulk upload (web)', url }])
    }
    rows.push([{ text: '❔ Help', callback_data: 'help' }])
    return rows
  }
  return [
    [{ text: `💳 Subscribe (${priceLabel()})`, callback_data: 'subscribe' }],
    [{ text: '🔑 Activate license', callback_data: 'activate' }],
    [{ text: '❔ Help', callback_data: 'help' }]
  ]
}

async function showMainMenu(token: string, chatId: number, user: TgUser, editId?: number): Promise<void> {
  session(chatId).mode = 'idle'
  const access = findAccessLicense(user.id, user.username)
  const text = mainMenuText(user, access)
  const kb = mainMenuKeyboard(user, access)
  if (editId) await editMessage(token, chatId, editId, text, kb)
  else await sendMessage(token, chatId, text, kb)
}

function backRow(): InlineKeyboard[number] {
  return [{ text: '⬅️ Back to menu', callback_data: 'menu' }]
}

// ── Subscribe / payment ──────────────────────────────────────────────────────

async function showCoinPicker(token: string, chatId: number, editId: number): Promise<void> {
  const cfg = getConfig()
  if (!cfg.nowPaymentsApiKey.trim()) {
    await editMessage(
      token,
      chatId,
      editId,
      '⚠️ Payments are not configured yet. Please contact the operator.',
      [backRow()]
    )
    return
  }
  const coinRows: InlineKeyboard = []
  const coins = cfg.payCurrencies
  for (let i = 0; i < coins.length; i += 2) {
    const row = coins.slice(i, i + 2).map((c) => ({
      text: c.toUpperCase(),
      callback_data: `pay:${c}`
    }))
    coinRows.push(row)
  }
  coinRows.push(backRow())
  await editMessage(
    token,
    chatId,
    editId,
    `💳 <b>Subscribe — ${priceLabel()}</b>\n\nChoose the crypto you want to pay with:`,
    coinRows
  )
}

async function startPayment(
  token: string,
  chatId: number,
  user: TgUser,
  payCurrency: string,
  editId: number
): Promise<void> {
  const cfg = getConfig()
  await editMessage(token, chatId, editId, `⏳ Creating your ${payCurrency.toUpperCase()} invoice…`)
  try {
    const orderId = `bugrette-${user.id}-${Date.now()}`
    const payment = await createPayment({
      priceUsd: cfg.priceUsd,
      payCurrency,
      orderId,
      description: `${APP_NAME} — 1 month subscription`
    })

    // Pre-generate a license key bound to this payment; issued once it settles.
    const license = createUnpaidLicense(String(payment.payment_id), payCurrency)

    const pending: PendingPayment = {
      paymentId: String(payment.payment_id),
      telegramId: user.id,
      username: user.username?.toLowerCase(),
      payCurrency,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      priceUsd: cfg.priceUsd,
      key: license.key,
      status: payment.payment_status,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    upsertPending(pending)

    const text =
      `💳 <b>Send exactly this payment</b>\n\n` +
      `Amount (tap to copy):\n<code>${payment.pay_amount}</code> ${payCurrency.toUpperCase()}\n\n` +
      `Address (tap to copy):\n<code>${escapeHtml(payment.pay_address)}</code>\n\n` +
      `Price: $${cfg.priceUsd} • 1 month\n\n` +
      `I'll detect the payment automatically and send your license key here. ` +
      `You can also tap “Check status”.`
    await editMessage(token, chatId, editId, text, [
      [{ text: '🔄 Check status', callback_data: `check:${payment.payment_id}` }],
      backRow()
    ])
  } catch (err) {
    const msg =
      err instanceof NowPaymentsError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Could not create the payment.'
    await editMessage(token, chatId, editId, `❌ ${escapeHtml(msg)}`, [
      [{ text: '🔁 Try again', callback_data: 'subscribe' }],
      backRow()
    ])
  }
}

async function checkPayment(
  token: string,
  chatId: number,
  paymentId: string,
  editId: number
): Promise<void> {
  const pending = allPending().find((p) => p.paymentId === paymentId)
  if (!pending) {
    await editMessage(token, chatId, editId, 'This payment is no longer pending. Open the menu to continue.', [
      backRow()
    ])
    return
  }
  try {
    const status = await getPaymentStatus(paymentId)
    pending.status = status.payment_status
    pending.updatedAt = Date.now()
    upsertPending(pending)

    if (isPaid(status.payment_status)) {
      await issueLicense(token, pending)
      return
    }
    if (isDead(status.payment_status)) {
      deletePending(paymentId)
      await editMessage(token, chatId, editId, `${statusLabel(status.payment_status)}. Please start again.`, [
        [{ text: '🔁 Try again', callback_data: 'subscribe' }],
        backRow()
      ])
      return
    }
    const text =
      `${statusLabel(status.payment_status)}\n\n` +
      `Amount (tap to copy):\n<code>${pending.payAmount}</code> ${pending.payCurrency.toUpperCase()}\n\n` +
      `Address (tap to copy):\n<code>${escapeHtml(pending.payAddress)}</code>`
    await editMessage(token, chatId, editId, text, [
      [{ text: '🔄 Check status', callback_data: `check:${paymentId}` }],
      backRow()
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not check payment status.'
    await editMessage(token, chatId, editId, `❌ ${escapeHtml(msg)}`, [
      [{ text: '🔄 Check status', callback_data: `check:${paymentId}` }],
      backRow()
    ])
  }
}

/**
 * A payment settled: mark its license paid and DM the buyer their key with an
 * "Activate now" button. Called by both the manual check and the poller.
 */
async function issueLicense(token: string, pending: PendingPayment): Promise<void> {
  markLicensePaid(pending.key)
  deletePending(pending.paymentId)

  const cfg = getConfig()
  const text =
    `🎉 <b>Payment received — thank you!</b>\n\n` +
    `Here is your ${APP_NAME} license key (${cfg.subscriptionDays} days):\n\n` +
    `<code>${pending.key}</code>\n\n` +
    `Tap the button below to activate it on this account, or send the key to the bot anytime with “Activate license”.`
  await sendMessage(token, pending.telegramId, text, [
    [{ text: '✅ Activate on my account', callback_data: `actkey:${pending.key}` }]
  ])
}

// ── Activation ───────────────────────────────────────────────────────────────

async function promptActivate(token: string, chatId: number, editId: number): Promise<void> {
  session(chatId).mode = 'await_license'
  await editMessage(
    token,
    chatId,
    editId,
    '🔑 <b>Activate license</b>\n\nSend me your license key (looks like <code>BUGR-XXXX-XXXX-XXXX-XXXX</code>).',
    [backRow()]
  )
}

async function doActivate(
  token: string,
  chatId: number,
  user: TgUser,
  key: string,
  editId?: number
): Promise<void> {
  const result = activateLicense(key, user.id, user.username)
  if (result.ok) {
    session(chatId).mode = 'idle'
    const lic = result.license
    const days = lic.expiresAt ? Math.ceil((lic.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : 0
    const text =
      `✅ <b>License activated!</b>\n\n` +
      `Your subscription is active for <b>${days} days</b>. ` +
      `Send me an image or video to spoof it, and use “Manage admins” to add up to ${getConfig().maxAdmins} teammates.`
    if (editId) await editMessage(token, chatId, editId, text, mainMenuKeyboard(user, findAccessLicense(user.id, user.username)))
    else await sendMessage(token, chatId, text, mainMenuKeyboard(user, findAccessLicense(user.id, user.username)))
    return
  }
  const reasons: Record<string, string> = {
    'not-found': 'That key was not found. Check for typos and try again.',
    revoked: 'That license has been revoked.',
    expired: 'That license has expired.',
    'used-by-other': 'That key is already activated on another account.',
    unpaid: 'That key has not been paid for yet.'
  }
  const msg = reasons[result.reason] || 'Could not activate that key.'
  if (editId) await editMessage(token, chatId, editId, `❌ ${msg}`, [backRow()])
  else await sendMessage(token, chatId, `❌ ${msg}`, [backRow()])
}

// ── Admin management (owner only) ────────────────────────────────────────────

async function showAdminMenu(token: string, chatId: number, user: TgUser, editId?: number): Promise<void> {
  const license = findOwnedLicense(user.id)
  if (!license) {
    const text = 'Only a license owner can manage admins.'
    if (editId) await editMessage(token, chatId, editId, text, [backRow()])
    else await sendMessage(token, chatId, text, [backRow()])
    return
  }
  const cfg = getConfig()
  const lines = license.admins.length
    ? license.admins.map((a, i) => `${i + 1}. @${escapeHtml(a.username)}${a.telegramId ? ' ✅' : ' (pending)'}`).join('\n')
    : '— none yet —'
  const text =
    `👥 <b>Manage admins</b> (${license.admins.length}/${cfg.maxAdmins})\n\n` +
    `Admins can use the spoofer under your subscription.\n\n${lines}`
  const rows: InlineKeyboard = []
  for (const a of license.admins) {
    rows.push([{ text: `🗑 Remove @${a.username}`, callback_data: `admin_rm:${a.username}` }])
  }
  if (license.admins.length < cfg.maxAdmins) {
    rows.push([{ text: '➕ Add admin', callback_data: 'admin_add' }])
  }
  rows.push(backRow())
  if (editId) await editMessage(token, chatId, editId, text, rows)
  else await sendMessage(token, chatId, text, rows)
}

async function promptAddAdmin(token: string, chatId: number, user: TgUser, editId: number): Promise<void> {
  const license = findOwnedLicense(user.id)
  if (!license) {
    await editMessage(token, chatId, editId, 'Only a license owner can add admins.', [backRow()])
    return
  }
  if (license.admins.length >= getConfig().maxAdmins) {
    await editMessage(token, chatId, editId, 'You have reached the admin limit.', [
      [{ text: '👥 Manage admins', callback_data: 'admins' }],
      backRow()
    ])
    return
  }
  session(chatId).mode = 'await_admin_add'
  await editMessage(
    token,
    chatId,
    editId,
    '➕ <b>Add admin</b>\n\nSend the Telegram <b>@username</b> of the person you want to authorise.',
    [[{ text: '⬅️ Cancel', callback_data: 'admins' }]]
  )
}

async function doAddAdmin(token: string, chatId: number, user: TgUser, rawUsername: string): Promise<void> {
  const license = findOwnedLicense(user.id)
  if (!license) {
    session(chatId).mode = 'idle'
    await sendMessage(token, chatId, 'Only a license owner can add admins.', [backRow()])
    return
  }
  const result = addAdmin(license, rawUsername)
  session(chatId).mode = 'idle'
  if (result.ok) {
    await sendMessage(
      token,
      chatId,
      `✅ Added @${escapeHtml(rawUsername.replace(/^@/, ''))}. They can now use the spoofer once they open the bot.`
    )
    await showAdminMenu(token, chatId, user)
    return
  }
  const reasons: Record<string, string> = {
    full: 'You have reached the admin limit.',
    duplicate: 'That username is already an admin.',
    invalid: 'That does not look like a valid Telegram username.',
    'is-owner': 'That is your own account — you already have full access.',
    'not-owner': 'Only a license owner can add admins.'
  }
  await sendMessage(token, chatId, `❌ ${reasons[result.reason] || 'Could not add that admin.'}`)
  await showAdminMenu(token, chatId, user)
}

async function doRemoveAdmin(
  token: string,
  chatId: number,
  user: TgUser,
  username: string,
  editId: number
): Promise<void> {
  const license = findOwnedLicense(user.id)
  if (!license) {
    await editMessage(token, chatId, editId, 'Only a license owner can remove admins.', [backRow()])
    return
  }
  removeAdmin(license, username)
  await showAdminMenu(token, chatId, user, editId)
}

// ── Subscription info ────────────────────────────────────────────────────────

async function showSubInfo(token: string, chatId: number, user: TgUser, editId: number): Promise<void> {
  const access = findAccessLicense(user.id, user.username)
  if (!access) {
    await editMessage(token, chatId, editId, 'You have no active subscription.', [
      [{ text: `💳 Subscribe (${priceLabel()})`, callback_data: 'subscribe' }],
      backRow()
    ])
    return
  }
  const lic = access.license
  const days = lic.expiresAt ? Math.max(0, Math.ceil((lic.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))) : 0
  const expiry = lic.expiresAt ? new Date(lic.expiresAt).toISOString().slice(0, 10) : 'unknown'
  const text =
    `📊 <b>Your subscription</b>\n\n` +
    `Role: <b>${access.role}</b>\n` +
    `Status: <b>active</b>\n` +
    `Days left: <b>${days}</b>\n` +
    `Renews/expires: <b>${expiry}</b>\n` +
    (access.role === 'owner' ? `Admins: <b>${lic.admins.length}/${getConfig().maxAdmins}</b>` : '')
  await editMessage(token, chatId, editId, text, [backRow()])
}

// ── Help ─────────────────────────────────────────────────────────────────────

async function showHelp(token: string, chatId: number, editId: number): Promise<void> {
  const text =
    `❔ <b>How ${APP_NAME} works</b>\n\n` +
    `1. Subscribe for ${priceLabel()} (crypto). You'll get a license key.\n` +
    `2. Activate the key on your Telegram account.\n` +
    `3. Send any image or video — I'll spoof it and send it back.\n` +
    `4. As the owner, add up to ${getConfig().maxAdmins} admins by @username so your team can use it too.\n\n` +
    `Spoofing strips metadata, rebuilds EXIF/container identity and perturbs pixels so exports don't share a fingerprint.`
  await editMessage(token, chatId, editId, text, [backRow()])
}

// ── Media spoofing ───────────────────────────────────────────────────────────

function mediaFromMessage(
  msg: TgMessage
): { fileId: string; name: string; size: number } | null {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1]
    return { fileId: best.file_id, name: `photo-${msg.message_id}.jpg`, size: best.file_size || 0 }
  }
  if (msg.video) {
    const ext = mimeExt(msg.video.mime_type) || '.mp4'
    return { fileId: msg.video.file_id, name: msg.video.file_name || `video-${msg.message_id}${ext}`, size: msg.video.file_size || 0 }
  }
  if (msg.animation) {
    return { fileId: msg.animation.file_id, name: msg.animation.file_name || `animation-${msg.message_id}.mp4`, size: msg.animation.file_size || 0 }
  }
  if (msg.document) {
    const name = msg.document.file_name || `file-${msg.message_id}`
    return { fileId: msg.document.file_id, name, size: msg.document.file_size || 0 }
  }
  return null
}

function mimeExt(mime?: string): string | null {
  if (!mime) return null
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  }
  return map[mime] || null
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 // Telegram Bot API getFile limit.

async function handleMedia(token: string, chatId: number, user: TgUser, msg: TgMessage): Promise<void> {
  const access = findAccessLicense(user.id, user.username)
  if (!access) {
    await sendMessage(
      token,
      chatId,
      `🔒 You need an active subscription to spoof media.`,
      [
        [{ text: `💳 Subscribe (${priceLabel()})`, callback_data: 'subscribe' }],
        [{ text: '🔑 Activate license', callback_data: 'activate' }]
      ]
    )
    return
  }

  const media = mediaFromMessage(msg)
  if (!media) return
  const ext = path.extname(media.name).toLowerCase()
  if (!isSpoofableExt(ext)) {
    await sendMessage(token, chatId, '⚠️ That file type is not supported. Send an image or a video.')
    return
  }
  if (media.size && media.size > MAX_DOWNLOAD_BYTES) {
    await sendMessage(
      token,
      chatId,
      '⚠️ That file is larger than 20 MB — Telegram bots can only download files up to 20 MB. Please send a smaller file.'
    )
    return
  }

  const progressMsg = await sendMessage(token, chatId, '⏳ Downloading…')
  const workDir = path.join(os.tmpdir(), 'bugrette-in', randomUUID())
  const srcPath = path.join(workDir, media.name)
  try {
    await downloadFile(token, media.fileId, srcPath)
    await editMessage(token, chatId, progressMsg.message_id, '🛡 Spoofing… this can take a moment for videos.')

    const cfg = getConfig()
    let lastPct = -1
    const result = await spoofToFolder(srcPath, cfg.outputFolder, (p) => {
      const pct = Math.round(p.progress * 100)
      if (pct >= lastPct + 15) {
        lastPct = pct
        void editMessage(token, chatId, progressMsg.message_id, `🛡 ${escapeHtml(p.label)} (${pct}%)`).catch(() => {})
      }
    })

    await editMessage(token, chatId, progressMsg.message_id, '📤 Uploading your spoofed file…')
    await sendDocument(token, chatId, result.path, '✅ Spoofed — fingerprints stripped & metadata rebuilt.')
    await editMessage(token, chatId, progressMsg.message_id, '✅ Done!')
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : 'Spoofing failed.'
    await editMessage(token, chatId, progressMsg.message_id, `❌ ${escapeHtml(msg2)}`).catch(() => {})
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Update routing ───────────────────────────────────────────────────────────

async function handleMessage(token: string, msg: TgMessage): Promise<void> {
  const user = msg.from
  if (!user || msg.chat.type !== 'private') return
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()

  // Media takes priority regardless of mode.
  if (mediaFromMessage(msg)) {
    await handleMedia(token, chatId, user, msg)
    return
  }

  // Commands always reset to the main menu.
  if (/^\/(start|menu)\b/.test(text)) {
    await showMainMenu(token, chatId, user)
    return
  }
  if (/^\/help\b/.test(text)) {
    const m = await sendMessage(token, chatId, '…')
    await showHelp(token, chatId, m.message_id)
    return
  }

  const s = session(chatId)
  if (s.mode === 'await_license' && text) {
    await doActivate(token, chatId, user, text)
    return
  }
  if (s.mode === 'await_admin_add' && text) {
    await doAddAdmin(token, chatId, user, text)
    return
  }

  // Anything else → show the menu.
  await showMainMenu(token, chatId, user)
}

async function handleCallback(token: string, cb: TgCallbackQuery): Promise<void> {
  const user = cb.from
  const msg = cb.message
  if (!msg) {
    await answerCallback(token, cb.id)
    return
  }
  const chatId = msg.chat.id
  const editId = msg.message_id
  const data = cb.data || ''
  await answerCallback(token, cb.id).catch(() => {})

  try {
    if (data === 'menu') return void (await showMainMenu(token, chatId, user, editId))
    if (data === 'subscribe') return void (await showCoinPicker(token, chatId, editId))
    if (data === 'activate') return void (await promptActivate(token, chatId, editId))
    if (data === 'admins') return void (await showAdminMenu(token, chatId, user, editId))
    if (data === 'admin_add') return void (await promptAddAdmin(token, chatId, user, editId))
    if (data === 'sub_info') return void (await showSubInfo(token, chatId, user, editId))
    if (data === 'help') return void (await showHelp(token, chatId, editId))
    if (data === 'spoof_help') {
      return void (await editMessage(
        token,
        chatId,
        editId,
        '🛡 Send me an <b>image</b> or <b>video</b> (up to 20 MB) and I\'ll spoof it and send it back.',
        [backRow()]
      ))
    }
    if (data.startsWith('pay:')) return void (await startPayment(token, chatId, user, data.slice(4), editId))
    if (data.startsWith('check:')) return void (await checkPayment(token, chatId, data.slice(6), editId))
    if (data.startsWith('actkey:')) return void (await doActivate(token, chatId, user, data.slice(7), editId))
    if (data.startsWith('admin_rm:')) return void (await doRemoveAdmin(token, chatId, user, data.slice(9), editId))
  } catch (err) {
    console.warn('[bot] callback failed:', err instanceof Error ? err.message : err)
  }
}

async function handleUpdate(token: string, u: TgUpdate): Promise<void> {
  if (u.message) await handleMessage(token, u.message)
  else if (u.callback_query) await handleCallback(token, u.callback_query)
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let loopStarted = false
let preparedToken = ''
let lastUpdateId = 0

export function startBot(): void {
  if (loopStarted) return
  loopStarted = true
  lastUpdateId = getLastUpdateId()

  void (async () => {
    for (;;) {
      const token = getConfig().botToken.trim()
      if (!token) {
        setStatus({ state: 'idle', message: 'No bot token configured.' })
        await sleep(4000)
        continue
      }
      try {
        if (token !== preparedToken) {
          const me = await getMe(token)
          await setMyCommands(token).catch(() => {})
          preparedToken = token
          setStatus({ state: 'ok', username: me.username })
        }
        const updates = await getUpdates(token, lastUpdateId + 1, 25)
        if (botStatus.state !== 'ok') setStatus({ state: 'ok', username: botStatus.username })
        for (const u of updates) {
          if (u.update_id > lastUpdateId) {
            lastUpdateId = u.update_id
            setLastUpdateId(lastUpdateId)
          }
          await handleUpdate(token, u).catch((err) =>
            console.warn('[bot] update failed:', err instanceof Error ? err.message : err)
          )
        }
      } catch (err) {
        const code = err instanceof TgApiError ? err.code : undefined
        const message = err instanceof Error ? err.message : 'Telegram request failed.'
        if (code === 409) {
          setStatus({ state: 'conflict', message })
          await sleep(15000)
        } else if (code === 401) {
          preparedToken = ''
          setStatus({ state: 'bad-token', message })
          await sleep(15000)
        } else {
          setStatus({ state: 'error', message })
          await sleep(5000)
        }
      }
    }
  })()
}

/** Force the loop to re-validate the token (getMe + commands) on next poll. */
export function restartBot(): void {
  preparedToken = ''
  setStatus({ state: 'idle', message: 'Reconnecting…' })
}

// ── Background payment poller ─────────────────────────────────────────────────

let pollerStarted = false

export function startPaymentPoller(): void {
  if (pollerStarted) return
  pollerStarted = true
  void (async () => {
    for (;;) {
      await sleep(20000)
      const cfg = getConfig()
      if (!cfg.nowPaymentsApiKey.trim() || !cfg.botToken.trim()) continue
      const token = cfg.botToken.trim()
      for (const pending of allPending()) {
        try {
          const status = await getPaymentStatus(pending.paymentId)
          if (status.payment_status === pending.status) continue
          pending.status = status.payment_status
          pending.updatedAt = Date.now()
          upsertPending(pending)

          if (isPaid(status.payment_status)) {
            await issueLicense(token, pending)
          } else if (isDead(status.payment_status)) {
            deletePending(pending.paymentId)
            await sendMessage(
              token,
              pending.telegramId,
              `${statusLabel(status.payment_status)}. Your payment did not complete — please start again with /menu.`
            ).catch(() => {})
          }
        } catch {
          // Network hiccup or rate limit — try again next cycle.
        }
      }
    }
  })()
}
