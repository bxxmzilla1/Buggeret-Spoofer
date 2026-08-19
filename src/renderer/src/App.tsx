import { useEffect, useState } from 'react'
import type { DashboardData, PublicConfig } from '@shared/types'
import logoUrl from './assets/logo.png'

const STATUS_META: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Online', cls: 'ok' },
  idle: { label: 'Idle', cls: 'idle' },
  error: { label: 'Error', cls: 'err' },
  'bad-token': { label: 'Bad token', cls: 'err' },
  conflict: { label: 'Conflict', cls: 'warn' }
}

function StatusBadge({ data }: { data: DashboardData | null }): JSX.Element {
  const state = data?.status.state ?? 'idle'
  const meta = STATUS_META[state] ?? STATUS_META.idle
  const uname = data?.status.username
  return (
    <div className={`badge ${meta.cls}`}>
      <span className="dot" />
      {meta.label}
      {uname ? <span className="uname">@{uname}</span> : null}
    </div>
  )
}

interface FormState {
  botToken: string
  nowPaymentsApiKey: string
  ipnSecret: string
  supabaseUrl: string
  supabaseKey: string
  priceUsd: number
  subscriptionDays: number
  maxAdmins: number
  payCurrencies: string
  spooferEnabled: boolean
  spooferMetaOnly: boolean
  webIntakeEnabled: boolean
  uploadPageUrl: string
  jobRetentionHours: number
  maxUploadMb: number
}

function formFromConfig(cfg: PublicConfig): FormState {
  return {
    botToken: '',
    nowPaymentsApiKey: '',
    ipnSecret: '',
    supabaseUrl: cfg.supabaseUrl,
    supabaseKey: '',
    priceUsd: cfg.priceUsd,
    subscriptionDays: cfg.subscriptionDays,
    maxAdmins: cfg.maxAdmins,
    payCurrencies: cfg.payCurrencies.join(', '),
    spooferEnabled: cfg.spooferEnabled,
    spooferMetaOnly: cfg.spooferMetaOnly,
    webIntakeEnabled: cfg.webIntakeEnabled,
    uploadPageUrl: cfg.uploadPageUrl,
    jobRetentionHours: cfg.jobRetentionHours,
    maxUploadMb: cfg.maxUploadMb
  }
}

export default function App(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    let mounted = true
    window.api.getDashboard().then((d) => {
      if (!mounted) return
      setData(d)
      setForm((prev) => prev ?? formFromConfig(d.config))
    })
    const off = window.api.onDashboard((d) => mounted && setData(d))
    return () => {
      mounted = false
      off()
    }
  }, [])

  if (!data || !form) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Starting Bugrette Spoofer…</p>
      </div>
    )
  }

  const cfg = data.config
  const f: FormState = form

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setForm({ ...f, [k]: v })

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        priceUsd: Number(f.priceUsd) || 200,
        subscriptionDays: Number(f.subscriptionDays) || 30,
        maxAdmins: Number(f.maxAdmins) || 5,
        payCurrencies: f.payCurrencies
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        spooferEnabled: f.spooferEnabled,
        spooferMetaOnly: f.spooferMetaOnly,
        webIntakeEnabled: f.webIntakeEnabled,
        uploadPageUrl: f.uploadPageUrl.trim(),
        jobRetentionHours: Number(f.jobRetentionHours) || 24,
        maxUploadMb: Number(f.maxUploadMb) || 200
      }
      // Only send secrets when the user actually typed something.
      if (f.botToken.trim()) patch.botToken = f.botToken.trim()
      if (f.nowPaymentsApiKey.trim()) patch.nowPaymentsApiKey = f.nowPaymentsApiKey.trim()
      if (f.ipnSecret.trim()) patch.ipnSecret = f.ipnSecret.trim()
      // Supabase URL isn't secret — only send it when it actually changed.
      if (f.supabaseUrl.trim() !== cfg.supabaseUrl) patch.supabaseUrl = f.supabaseUrl.trim()
      if (f.supabaseKey.trim()) patch.supabaseKey = f.supabaseKey.trim()

      await window.api.saveConfig(patch)
      setForm({ ...f, botToken: '', nowPaymentsApiKey: '', ipnSecret: '', supabaseKey: '' })
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  async function pickFolder(): Promise<void> {
    await window.api.pickFolder()
  }

  async function genLicense(): Promise<void> {
    await window.api.createLicense()
  }

  async function revoke(key: string): Promise<void> {
    if (confirm(`Revoke license ${key}? This immediately disables the subscriber.`)) {
      await window.api.revokeLicense(key)
    }
  }

  const activeCount = data.licenses.filter((l) => l.status === 'active').length

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="Bugrette Spoofer" />
          <div>
            <h1>
              Bugrette <span className="accent-text">Spoofer</span>
            </h1>
            <p className="sub">Telegram spoofing bot · 24/7 control panel</p>
          </div>
        </div>
        <div className="topbar-right">
          <StatusBadge data={data} />
          {data.status.state === 'ok' && data.status.username ? (
            <button
              className="primary"
              onClick={() => window.api.openExternal(`https://t.me/${data.status.username}`)}
            >
              Open bot in Telegram
            </button>
          ) : null}
          <button className="ghost" onClick={() => setShowSettings(true)}>
            ⚙ Settings
          </button>
          <button className="ghost" onClick={() => window.api.restartBot()}>
            Reconnect
          </button>
        </div>
      </header>

      {data.status.state === 'ok' && data.status.username ? (
        <div className="alert ok">
          Bot is online as <b>@{data.status.username}</b>. Open Telegram, go to{' '}
          <button
            className="link"
            onClick={() => window.api.openExternal(`https://t.me/${data.status.username}`)}
          >
            t.me/{data.status.username}
          </button>{' '}
          and press <b>Start</b>.
        </div>
      ) : null}

      {data.status.message && data.status.state !== 'ok' ? (
        <div className={`alert ${data.status.state === 'conflict' ? 'warn' : 'err'}`}>{data.status.message}</div>
      ) : null}

      <div className="stats">
        <div className="stat">
          <span className="stat-num">{activeCount}</span>
          <span className="stat-label">Active subscribers</span>
        </div>
        <div className="stat">
          <span className="stat-num">{data.pending.length}</span>
          <span className="stat-label">Pending payments</span>
        </div>
        <div className="stat">
          <span className="stat-num">${cfg.priceUsd}</span>
          <span className="stat-label">Price / {cfg.subscriptionDays}d</span>
        </div>
        <div className="stat">
          <span className={`stat-pill ${cfg.hasBotToken ? 'on' : 'off'}`}>Bot</span>
          <span className={`stat-pill ${cfg.hasNowPaymentsKey ? 'on' : 'off'}`}>Payments</span>
          <span className={`stat-pill ${cfg.hasSupabaseKey ? 'on' : 'off'}`}>Database</span>
        </div>
      </div>

      <main className="grid">
        <section className="card">
          <div className="card-head">
            <h2>Licenses</h2>
            <button className="ghost" onClick={genLicense}>
              + Generate free key
            </button>
          </div>
          {data.licenses.length === 0 ? (
            <p className="empty">No licenses yet. They appear here after a subscriber pays.</p>
          ) : (
            <div className="table">
              <div className="tr th">
                <span>Key</span>
                <span>Status</span>
                <span>Owner</span>
                <span>Admins</span>
                <span>Days</span>
                <span></span>
              </div>
              {data.licenses.map((l) => (
                <div className="tr" key={l.key}>
                  <span className="mono">{l.key}</span>
                  <span className={`status ${l.status}`}>{l.status}</span>
                  <span>{l.ownerUsername ? `@${l.ownerUsername}` : l.ownerTelegramId || '—'}</span>
                  <span>{l.admins.length}</span>
                  <span>{l.daysLeft ?? '—'}</span>
                  <span>
                    <button className="danger-link" onClick={() => revoke(l.key)}>
                      revoke
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Pending payments</h2>
          {data.pending.length === 0 ? (
            <p className="empty">No pending crypto payments.</p>
          ) : (
            <div className="table">
              <div className="tr th pending">
                <span>User</span>
                <span>Coin</span>
                <span>Amount</span>
                <span>Status</span>
              </div>
              {data.pending.map((p) => (
                <div className="tr pending" key={p.paymentId}>
                  <span>{p.username ? `@${p.username}` : p.telegramId}</span>
                  <span className="mono">{p.payCurrency.toUpperCase()}</span>
                  <span className="mono">{p.payAmount}</span>
                  <span className="status">{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="foot">
        Keep this app running for the bot to stay online. Closing the window keeps the bot alive; quit from the
        taskbar to stop it.
      </footer>

      {showSettings ? (
        <div className="modal-overlay" onMouseDown={() => setShowSettings(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>⚙ Settings</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="modal-body">
              <h3 className="group-title">Credentials &amp; API keys</h3>

              <div className="field">
                <label>
                  Telegram bot token{' '}
                  <span className={cfg.hasBotToken ? 'chip ok' : 'chip'}>
                    {cfg.hasBotToken ? 'configured' : 'not set'}
                  </span>
                </label>
                <input
                  type="password"
                  placeholder={cfg.hasBotToken ? '•••••••• (leave blank to keep)' : 'Paste token from @BotFather'}
                  value={form.botToken}
                  onChange={(e) => set('botToken', e.target.value)}
                />
              </div>

              <div className="field">
                <label>
                  NowPayments API key{' '}
                  <span className={cfg.hasNowPaymentsKey ? 'chip ok' : 'chip'}>
                    {cfg.hasNowPaymentsKey ? 'configured' : 'not set'}
                  </span>
                </label>
                <input
                  type="password"
                  placeholder={cfg.hasNowPaymentsKey ? '•••••••• (leave blank to keep)' : 'NowPayments dashboard → API key'}
                  value={form.nowPaymentsApiKey}
                  onChange={(e) => set('nowPaymentsApiKey', e.target.value)}
                />
              </div>

              <div className="field">
                <label>
                  Supabase URL{' '}
                  <span className={cfg.supabaseUrl ? 'chip ok' : 'chip'}>
                    {cfg.supabaseUrl ? 'set' : 'not set'}
                  </span>
                  <span className="hint"> — users &amp; admins are stored here</span>
                </label>
                <input
                  type="text"
                  placeholder="https://xxxxxxxx.supabase.co"
                  value={form.supabaseUrl}
                  onChange={(e) => set('supabaseUrl', e.target.value)}
                />
              </div>

              <div className="field">
                <label>
                  Supabase service_role key{' '}
                  <span className={cfg.hasSupabaseKey ? 'chip ok' : 'chip'}>
                    {cfg.hasSupabaseKey ? 'configured' : 'not set'}
                  </span>
                </label>
                <input
                  type="password"
                  placeholder={cfg.hasSupabaseKey ? '•••••••• (leave blank to keep)' : 'Project Settings → API → service_role'}
                  value={form.supabaseKey}
                  onChange={(e) => set('supabaseKey', e.target.value)}
                />
              </div>

              <h3 className="group-title">Subscription</h3>

              <div className="row3">
                <div className="field">
                  <label>Price (USD/mo)</label>
                  <input type="number" value={form.priceUsd} onChange={(e) => set('priceUsd', Number(e.target.value))} />
                </div>
                <div className="field">
                  <label>Subscription days</label>
                  <input
                    type="number"
                    value={form.subscriptionDays}
                    onChange={(e) => set('subscriptionDays', Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Max admins</label>
                  <input type="number" value={form.maxAdmins} onChange={(e) => set('maxAdmins', Number(e.target.value))} />
                </div>
              </div>

              <div className="field">
                <label>Accepted coins (comma-separated NowPayments codes)</label>
                <input
                  type="text"
                  value={form.payCurrencies}
                  onChange={(e) => set('payCurrencies', e.target.value)}
                  placeholder="btc, eth, usdttrc20, ltc, sol"
                />
              </div>

              <h3 className="group-title">Spoofer</h3>

              <div className="field">
                <label>Output folder (spoofed files are saved here on this PC)</label>
                <div className="folder">
                  <input type="text" readOnly value={cfg.outputFolder} />
                  <button className="ghost" onClick={pickFolder}>
                    Choose…
                  </button>
                </div>
              </div>

              <div className="toggles">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={form.spooferEnabled}
                    onChange={(e) => set('spooferEnabled', e.target.checked)}
                  />
                  <span>Spoofer enabled</span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={form.spooferMetaOnly}
                    onChange={(e) => set('spooferMetaOnly', e.target.checked)}
                  />
                  <span>Metadata-only mode (skip pixel perturbation)</span>
                </label>
              </div>

              <h3 className="group-title">Web bulk upload</h3>

              <div className="toggles">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={form.webIntakeEnabled}
                    onChange={(e) => set('webIntakeEnabled', e.target.checked)}
                  />
                  <span>Enable web bulk-upload intake (requires Supabase)</span>
                </label>
              </div>

              <div className="field">
                <label>Upload page URL (where you host web/index.html)</label>
                <input
                  type="text"
                  value={form.uploadPageUrl}
                  onChange={(e) => set('uploadPageUrl', e.target.value)}
                  placeholder="https://your-upload-page.example.com"
                />
              </div>

              <div className="row3">
                <div className="field">
                  <label>Auto-delete after (hours)</label>
                  <input
                    type="number"
                    min={1}
                    value={form.jobRetentionHours}
                    onChange={(e) => set('jobRetentionHours', Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Max file size (MB)</label>
                  <input
                    type="number"
                    min={1}
                    value={form.maxUploadMb}
                    onChange={(e) => set('maxUploadMb', Number(e.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="modal-foot">
              {savedAt ? <span className="saved">Saved ✓</span> : <span />}
              <div className="modal-foot-actions">
                <button className="ghost" onClick={() => setShowSettings(false)}>
                  Close
                </button>
                <button className="primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
