import { promises as fs } from 'node:fs'
import path from 'node:path'

// Thin wrapper over the Telegram Bot API (https://core.telegram.org/bots/api).
// Uses long-polling via getUpdates; no external library needed.

const API = 'https://api.telegram.org'

export class TgApiError extends Error {
  constructor(
    message: string,
    public code?: number
  ) {
    super(message)
    this.name = 'TgApiError'
  }
}

export interface TgUser {
  id: number
  is_bot: boolean
  first_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: string
  username?: string
  first_name?: string
  title?: string
}

export interface TgFileInfo {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_name?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
  caption?: string
  photo?: Array<TgFileInfo & { width: number; height: number }>
  video?: TgFileInfo & { mime_type?: string }
  document?: TgFileInfo & { mime_type?: string }
  animation?: TgFileInfo & { mime_type?: string }
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

export type InlineKeyboard = InlineButton[][]

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function callJson<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number }
  if (!data.ok) {
    throw new TgApiError(data.description || `Telegram ${method} failed.`, data.error_code)
  }
  return data.result as T
}

export function getUpdates(
  token: string,
  offset: number,
  timeout = 25
): Promise<TgUpdate[]> {
  return callJson<TgUpdate[]>(token, 'getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message', 'callback_query']
  })
}

export function getMe(token: string): Promise<TgUser> {
  return callJson<TgUser>(token, 'getMe')
}

export function setMyCommands(token: string): Promise<boolean> {
  return callJson<boolean>(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Open the Bugrette Spoofer menu' },
      { command: 'menu', description: 'Open the Bugrette Spoofer menu' },
      { command: 'help', description: 'How Bugrette Spoofer works' }
    ]
  })
}

export function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard
): Promise<TgMessage> {
  return callJson<TgMessage>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  })
}

export async function editMessage(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  try {
    await callJson(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    })
  } catch (err) {
    // "message is not modified" and stale-message errors are non-fatal.
    if (err instanceof TgApiError && /not modified|message to edit not found/i.test(err.message)) return
    throw err
  }
}

export function answerCallback(
  token: string,
  callbackId: string,
  text?: string
): Promise<boolean> {
  return callJson<boolean>(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {})
  })
}

/** Resolve a file_id to a download URL and fetch its bytes into `destPath`. */
export async function downloadFile(
  token: string,
  fileId: string,
  destPath: string
): Promise<string> {
  const info = await callJson<{ file_path?: string }>(token, 'getFile', { file_id: fileId })
  if (!info.file_path) throw new TgApiError('Telegram did not return a file path (file too large?).')
  const res = await fetch(`${API}/file/bot${token}/${info.file_path}`)
  if (!res.ok) throw new TgApiError(`Failed to download file (${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await fs.writeFile(destPath, buf)
  return destPath
}

/** Send a local file back to a chat as a document (preserves quality/metadata). */
export async function sendDocument(
  token: string,
  chatId: number | string,
  filePath: string,
  caption?: string
): Promise<void> {
  const buf = await fs.readFile(filePath)
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) {
    form.append('caption', caption)
    form.append('parse_mode', 'HTML')
  }
  form.append('document', new Blob([buf]), path.basename(filePath))
  const res = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form })
  const data = (await res.json()) as { ok: boolean; description?: string; error_code?: number }
  if (!data.ok) throw new TgApiError(data.description || 'sendDocument failed.', data.error_code)
}
