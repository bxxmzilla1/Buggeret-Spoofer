# 🐞 Bugrette Spoofer

A Telegram bot that **spoofs images and videos** (strips fingerprints, rebuilds
EXIF/container identity and perturbs pixels so no two exports share a
signature). It is gated behind a **$200/month crypto subscription** paid via
[NowPayments](https://nowpayments.io), and it runs **24/7 inside an Electron
desktop app** on a PC you control.

The spoofing engine is a self-contained native port of the original Python
spoofer — it uses bundled `ffmpeg`/`ffprobe` binaries and a pure-JS EXIF writer,
so no Python install or external scripts are required.

---

## How it works

```
Buyer → /start → Subscribe ($200/mo) → picks a coin → pays crypto
      → NowPayments confirms → bot DMs a license key
      → buyer activates key on their Telegram account
      → buyer (owner) can add up to 5 admins by @username
      → owner + admins send any image/video → bot returns the spoofed file
```

Everything the user does happens through **inline-keyboard menus**. The Electron
window is a **control dashboard** for the operator (you): configure the bot
token and NowPayments key, watch the bot's status, and manage issued licenses.

### Roles
- **Owner** — the person who activates a license key. Can spoof media, view the
  subscription, and manage admins.
- **Admin** — up to 5 Telegram usernames the owner authorises. They can spoof
  media under the owner's subscription. Their account is bound automatically the
  first time they open the bot.

---

## Prerequisites

1. **Node.js 18+** and **npm** installed.
2. A **Telegram bot token** from [@BotFather](https://t.me/BotFather).
3. A **NowPayments account** with an **API key** (Dashboard → Store Settings →
   API keys) and at least one payout wallet configured.

---

## Install & run (development)

```bash
npm install
npm run dev      # launches the Electron app + hot-reloading dashboard
```

## Build a distributable (Windows)

```bash
npm run dist:win   # produces an installer + portable .exe in dist/
```

> `ffmpeg`/`ffprobe` are shipped as native binaries and unpacked from the asar
> archive automatically (see `electron-builder.yml`).

---

## First-time setup (in the dashboard)

1. Launch the app.
2. Paste your **Telegram bot token** and **NowPayments API key** and click
   **Save settings**. The status badge turns **Online** and shows `@yourbot`.
3. (Optional but recommended) Add your **Supabase URL + service_role key** so
   users and admins are stored in a real database (see below).
4. (Optional) Adjust price, subscription length, max admins, accepted coins, the
   output folder (where spoofed files are also saved on this PC), and the
   spoofer toggles.
5. Leave the app running. Closing the window keeps the bot alive; quit from the
   taskbar/Task Manager to stop it.

---

## Supabase (users & admins database)

License owners ("users") and their admins are mirrored to a Supabase database so
the data is durable, queryable, and survives reinstalls. The local
`electron-store` remains the fast source of truth the bot reads on every update;
Supabase is written on every change and loaded back (authoritatively) on
startup.

**Setup:**
1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql) to
   create the `licenses` and `admins` tables (plus an `access_users` view that
   lists every owner + admin with their role).
3. In the app dashboard, paste your **Project URL** (Settings → API → Project
   URL) and **service_role key** (Settings → API → `service_role`), then **Save
   settings**.

> The `service_role` key bypasses Row Level Security and is used only inside the
> Electron main process — never expose it in a browser or share it.

**Tables**
- `licenses` — one row per subscription: key, status, timestamps, owner Telegram
  id/username, and the funding payment.
- `admins` — the up-to-5 authorised admins per license (username + bound
  Telegram id).
- `access_users` (view) — a convenient union of owners + admins with role.

---

## Web bulk upload (mass spoofing via a link)

For spoofing many files at once, a **static web page** lets a subscriber drop
dozens of images/videos and download the spoofed results — without hitting
Telegram's 20 MB limit. It uses **Supabase Storage as the broker** (Architecture
A): the browser uploads raw files to Supabase, the 24/7 desktop app processes
them locally with the same spoofing engine, uploads the results back, and hands
out **time-limited signed download links**. Everything **auto-deletes** to save
storage.

```
Browser (upload page) ──uploads──▶ Supabase Storage (spoof-uploads)
        │  + inserts job row (status=queued)
        ▼
Desktop app worker ──claims job──▶ downloads inputs → spoofs → uploads results
        │                          (spoof-outputs) → signed URLs on the job row
        │                          → deletes inputs now, outputs after retention
        ▼
Browser polls the job row ──▶ shows a download link per file
```

**Setup:**
1. Configure **Supabase** first (see the section above) and re-run
   [`supabase/schema.sql`](supabase/schema.sql). It now also creates the
   `spoof_jobs` table, the `spoof-uploads` / `spoof-outputs` storage buckets,
   the `is_license_active()` validator, and the anon RLS policies.
2. In the dashboard **Settings → Web bulk upload**: turn on **Enable web
   bulk-upload intake**, set **Auto-delete after (hours)** and **Max file size
   (MB)**, and paste the **Upload page URL** where you'll host the page.
3. Edit [`web/index.html`](web/index.html) and fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` (Project Settings → API — the **anon public** key, which
   is safe to expose; **never** the service_role key). Keep `MAX_UPLOAD_MB` in
   sync with the dashboard setting.
4. Host `web/index.html` anywhere static (Netlify, Vercel, GitHub Pages, or even
   a Supabase public bucket) and put that URL in the dashboard.

Once enabled, owners get a **🌐 Bulk upload (web)** button in the bot menu that
opens the page with their license key pre-filled. The page validates the key,
uploads the files, queues a job, and shows live progress + download links. If
the job originated from a Telegram user, the bot also DMs the finished links.

> **Security model:** the page uses the **anon** key with Row Level Security.
> Anon can only *insert* a job for an **active** license (checked by a
> security-definer function, so the licenses table itself is never exposed) and
> can read job progress **without** the `license_key` column. Outputs are
> private and only reachable via signed URLs. The bulk-upload button is
> **owner-only** because the link carries the license key.

---

## Payments

- Payments use NowPayments **direct payments + polling** (no public webhook URL
  needed, so it works on a home/office PC).
- When a buyer picks a coin, the bot creates a payment for **$200 USD** in that
  coin and shows the exact amount + address.
- A background poller (every ~20s) checks each pending payment. When NowPayments
  reports `finished`, the bot DMs the buyer their license key automatically.
- Accepted coins are configurable (default: BTC, ETH, USDT-TRC20, USDT-ERC20,
  LTC, SOL, TRX, BNB). Use NowPayments currency codes.

---

## License keys

- Format: `BUGR-XXXX-XXXX-XXXX-XXXX` (unambiguous alphabet, easy to copy).
- A key is generated per payment and issued once the payment confirms.
- Activation binds the key to one Telegram account and starts the 30-day clock.
- The operator can also **generate a free key** from the dashboard (e.g. for
  testing or comps) and **revoke** any license instantly.

---

## Project structure

```
src/
  shared/types.ts     Shared types + IPC contract
  main/
    index.ts          Electron entry, IPC handlers, single-instance lock
    bot.ts            Telegram long-poll loop, inline menus, all flows
    tg.ts             Telegram Bot API client (fetch-based)
    payments.ts       NowPayments REST client
    license.ts        License key generation / activation / admins
    supabase.ts       Users/admins mirror to Supabase (+ load on start)
    jobs.ts           Web bulk-upload worker (claim, spoof, upload, auto-delete)
    store.ts          Persistent config (electron-store)
    spoofer.ts        Image + video spoofing engine
    ffmpeg.ts         Bundled ffmpeg/ffprobe binary resolution
  preload/index.ts    Typed, sandboxed bridge to the renderer
  renderer/           React control dashboard (dark UI)
web/index.html        Standalone bulk-upload page (host it publicly)
supabase/schema.sql   Tables, buckets, RLS policies (run once)
```

---

## Notes & limits

- Telegram bots can **download files up to 20 MB** via the Bot API. Larger files
  are rejected with a friendly message. (Uploads back to the user can be up to
  50 MB.)
- Only **one** app instance may run per bot token (Telegram allows a single
  `getUpdates` consumer); a single-instance lock enforces this.
- Secrets (bot token, NowPayments key) live only in the main process and are
  never sent to the renderer — the UI only sees masked "configured" flags.
