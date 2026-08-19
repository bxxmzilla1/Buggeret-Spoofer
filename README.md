# 🐞 Bugrette Spoofer

A Telegram bot that **spoofs images and videos** (strips fingerprints, rebuilds
EXIF/container identity and perturbs pixels so no two exports share a
signature). Access is gated behind **license keys you generate in the app and
assign to a specific Telegram username**, and it runs **24/7 inside an Electron
desktop app** on a PC you control.

The spoofing engine is a self-contained native port of the original Python
spoofer — it uses bundled `ffmpeg`/`ffprobe` binaries and a pure-JS EXIF writer,
so no Python install or external scripts are required.

---

## How it works

```
Operator → dashboard → types a Telegram @username → "Assign license"
         → gives the generated key to that user
User     → /start → "Enter license key" → sends the key
         → bot activates it ONLY if their @username matches the assignment
         → user (owner) can add up to 5 admins by @username
         → owner + admins send any image/video → bot returns the spoofed file
```

Everything the user does happens through **inline-keyboard menus**. The Electron
window is a **control dashboard** for the operator (you): configure the bot
token, watch the bot's status, and generate/assign/revoke licenses.

### Roles
- **Owner** — the person a license is assigned to and who activates it. Can
  spoof media, view the license, and manage admins.
- **Admin** — up to 5 Telegram usernames the owner authorises. They can spoof
  media under the owner's subscription. Their account is bound automatically the
  first time they open the bot.

---

## Prerequisites

1. **Node.js 18+** and **npm** installed.
2. A **Telegram bot token** from [@BotFather](https://t.me/BotFather).
3. (Optional) A **Supabase project** if you want durable storage and the web
   bulk-upload pipeline (see below).

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
2. Open **⚙ Settings**, paste your **Telegram bot token**, and click **Save
   settings**. The status badge turns **Online** and shows `@yourbot`.
3. (Optional but recommended) Add your **Supabase URL + service_role key** so
   licenses and admins are stored in a real database (see below).
4. (Optional) Adjust license length (days), max admins, the output folder (where
   spoofed files are saved on this PC), and the spoofer toggles.
5. In the **Licenses** card, assign keys to Telegram usernames as needed.
6. Leave the app running. Closing the window keeps the bot alive; quit from the
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

For spoofing many files at once, a **static web page** lets a user drop dozens of
images/videos and get the spoofed results — without hitting Telegram's 20 MB
limit. Access is granted by a **temporary upload link (token) that expires after
30 minutes**, not by a license key. It uses **Supabase Storage as the broker**
(Architecture A): the browser uploads raw files to Supabase, the 24/7 desktop app
processes them locally with the same spoofing engine, uploads the results back,
and hands out **time-limited signed download links** (also DM'd to the requester).
Everything **auto-deletes** to save storage.

```
Bot: user taps “Bulk upload” ──▶ desktop app mints a 30-min token → link (#t=…)
Browser (link) ──uploads──▶ Supabase Storage (spoof-uploads)
        │  + inserts job row (status=queued, references the token)
        ▼
Desktop app worker ──claims job──▶ downloads inputs → spoofs → uploads results
        │                          (spoof-outputs) → signed URLs on the job row
        │                          → DMs links to the requester
        │                          → deletes inputs now, outputs after retention
        ▼
Browser polls the job row ──▶ shows a download link per file
```

**Setup:**
1. Configure **Supabase** first (see the section above) and re-run
   [`supabase/schema.sql`](supabase/schema.sql). It creates the `spoof_jobs` and
   `upload_tokens` tables, the `spoof-uploads` / `spoof-outputs` storage buckets,
   the `is_upload_token_valid()` validator, and the anon RLS policies.
2. In the dashboard **Settings → Web bulk upload**: turn on **Enable web
   bulk-upload intake**, set **Auto-delete after (hours)** and **Max file size
   (MB)**, and paste the **Upload page URL** where you'll host the page.
3. Edit [`web/index.html`](web/index.html) and fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` (Project Settings → API — the **anon public** key, which
   is safe to expose; **never** the service_role key). Keep `MAX_UPLOAD_MB` in
   sync with the dashboard setting.
4. Host `web/index.html` anywhere static (Netlify, Vercel, GitHub Pages, or even
   a Supabase public bucket) and put that URL in the dashboard.

Once enabled, any user with bot access gets a **🌐 Bulk upload (web)** button.
Tapping it mints a fresh link valid for 30 minutes. The page validates the token,
uploads the files, queues a job, shows live progress + download links, and the
bot DMs the finished links to whoever requested the link.

> **Security model:** the page uses the **anon** key with Row Level Security.
> Anon can only *insert* a job against a **valid, unexpired token** (checked by a
> security-definer function, so the tokens table itself is never exposed) and can
> read job progress on limited columns only (no tokens or ids). Outputs are
> private and reachable only via signed URLs. Tokens are minted server-side by
> the desktop app (service_role) and expire after 30 minutes.

---

## Issuing licenses

- In the dashboard's **Licenses** card, type the recipient's Telegram
  **@username** and click **Assign license**. A key is generated and reserved
  for that username (status `assigned`).
- Send the key to the user. They open the bot, tap **Enter license key**, and
  send it. Activation **only succeeds if their Telegram @username matches** the
  one you assigned — otherwise it's rejected. (The user must have a Telegram
  username set.)
- On activation the key binds to that account and starts the license clock
  (**License length (days)** in Settings → Access, default 30). Format:
  `BUGR-XXXX-XXXX-XXXX-XXXX`.
- **Revoke** any license instantly from the dashboard; the user loses access on
  their next action.

---

## Project structure

```
src/
  shared/types.ts     Shared types + IPC contract
  main/
    index.ts          Electron entry, IPC handlers, single-instance lock
    bot.ts            Telegram long-poll loop, inline menus, all flows
    tg.ts             Telegram Bot API client (fetch-based)
    license.ts        License key generation / username-assigned activation
    supabase.ts       Licenses/admins mirror to Supabase (+ load on start)
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
- A user must have a Telegram **@username** set to activate a license (matching
  is by username). Users without one are told to set one first.
- Secrets (bot token, Supabase service_role key) live only in the main process
  and are never sent to the renderer — the UI only sees masked "configured"
  flags.
