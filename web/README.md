# Bugrette Spoofer — Bulk Upload page

A single static page (`index.html`) where subscribers drop many images/videos to
be spoofed by the 24/7 desktop app, then download the results. No build step.

It's already wired to the Supabase project:

- **Project URL:** `https://vujacxvysogtuyoumycw.supabase.co`
- **Anon key:** embedded in `index.html` (anon keys are public by design — this
  is safe to commit and deploy; the `service_role` key is **never** here).

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project** and import the repo.
3. Set **Root Directory** to `web` (this folder). Framework preset: **Other**.
   Leave Build Command empty and Output Directory empty — it's a static file.
4. **Deploy.** Your page will be live at `https://<project>.vercel.app`.

## Point the app at it

In the desktop dashboard → **Settings → Web bulk upload**:

- Enable **web bulk-upload intake**.
- Paste the Vercel URL into **Upload page URL**.
- Set **Max file size (MB)** to match `MAX_UPLOAD_MB` in `index.html` (200).

## Prerequisites

Run [`../supabase/schema.sql`](../supabase/schema.sql) once in the Supabase SQL
editor so the `spoof_jobs` table, the `spoof-uploads` / `spoof-outputs` buckets,
and the anon RLS policies exist.
