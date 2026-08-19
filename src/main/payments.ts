import { getConfig } from './store'

// NowPayments REST client (https://documenter.getpostman.com/view/7907941).
// We use direct payments + polling rather than IPN webhooks, because this app
// runs on a home/office PC without a public callback URL. A background poller
// in the main process checks each pending payment's status until it settles.

const API_BASE = 'https://api.nowpayments.io/v1'

export class NowPaymentsError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message)
    this.name = 'NowPaymentsError'
  }
}

function apiKey(): string {
  const key = getConfig().nowPaymentsApiKey.trim()
  if (!key) throw new NowPaymentsError('NowPayments API key is not configured.')
  return key
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': apiKey(),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { message: text }
  }
  if (!res.ok) {
    const msg =
      (parsed as { message?: string })?.message ||
      (parsed as { code?: string })?.code ||
      `NowPayments request failed (${res.status}).`
    throw new NowPaymentsError(msg, res.status)
  }
  return parsed as T
}

export interface NpPayment {
  payment_id: number | string
  payment_status: string
  pay_address: string
  pay_amount: number
  pay_currency: string
  price_amount: number
  price_currency: string
  order_id?: string
  order_description?: string
  payin_extra_id?: string | null
}

/** True when NowPayments confirms funds are in and settled. */
export function isPaid(status: string): boolean {
  return status === 'finished'
}

/** True when the payment can never complete and should be dropped. */
export function isDead(status: string): boolean {
  return status === 'failed' || status === 'refunded' || status === 'expired'
}

/** Human label for a NowPayments status. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'waiting':
      return '⏳ Waiting for your payment'
    case 'confirming':
      return '🔎 Payment seen — confirming on-chain'
    case 'confirmed':
      return '✅ Confirmed — finalizing'
    case 'sending':
      return '📤 Finalizing payout'
    case 'partially_paid':
      return '⚠️ Partially paid — send the remaining amount'
    case 'finished':
      return '🎉 Payment complete'
    case 'failed':
      return '❌ Payment failed'
    case 'refunded':
      return '↩️ Payment refunded'
    case 'expired':
      return '⌛ Payment expired'
    default:
      return status
  }
}

/** Verify the API key is valid and the account is reachable. */
export async function checkHealth(): Promise<boolean> {
  const res = await call<{ message: string }>('GET', '/status')
  return res.message === 'OK'
}

/** Create a crypto payment for a fixed USD price in the chosen coin. */
export async function createPayment(opts: {
  priceUsd: number
  payCurrency: string
  orderId: string
  description: string
}): Promise<NpPayment> {
  return call<NpPayment>('POST', '/payment', {
    price_amount: opts.priceUsd,
    price_currency: 'usd',
    pay_currency: opts.payCurrency,
    order_id: opts.orderId,
    order_description: opts.description
  })
}

export async function getPaymentStatus(paymentId: string): Promise<NpPayment> {
  return call<NpPayment>('GET', `/payment/${paymentId}`)
}

/** The minimum amount (in the pay currency) NowPayments will accept. */
export async function getMinAmount(payCurrency: string): Promise<number> {
  const res = await call<{ min_amount: number }>(
    'GET',
    `/min-amount?currency_from=usd&currency_to=${encodeURIComponent(payCurrency)}&fiat_equivalent=usd`
  )
  return Number(res.min_amount) || 0
}
