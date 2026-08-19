-- Bugrette Spoofer — Supabase schema for users (license owners) & admins.
-- Run this once in the Supabase SQL editor for your project.
--
-- The app connects with the service_role key from the main process only, so
-- Row Level Security is left enabled with no public policies (service_role
-- bypasses RLS). Do NOT expose the service_role key in any client/browser.

-- Licenses (issued by the operator and assigned to a Telegram username).
create table if not exists public.licenses (
  key               text primary key,
  status            text not null default 'assigned',
  created_at        bigint not null,
  assigned_username text,
  activated_at      bigint,
  expires_at        bigint,
  owner_telegram_id bigint,
  owner_username    text,
  payment_id        text,
  pay_currency      text
);

-- Migration for projects created before username-assigned licenses existed.
alter table public.licenses add column if not exists assigned_username text;

-- Authorised admins (up to 5 per license).
create table if not exists public.admins (
  license_key text not null references public.licenses (key) on delete cascade,
  username    text not null,
  telegram_id bigint,
  primary key (license_key, username)
);

create index if not exists admins_username_idx on public.admins (username);
create index if not exists admins_telegram_id_idx on public.admins (telegram_id);
create index if not exists licenses_owner_idx on public.licenses (owner_telegram_id);

-- Keep RLS on; only the service_role key (used by the desktop app) can read/write.
alter table public.licenses enable row level security;
alter table public.admins   enable row level security;

-- Convenience view: every person with access (owners + admins) in one place.
create or replace view public.access_users as
  select
    l.owner_telegram_id as telegram_id,
    l.owner_username    as username,
    'owner'             as role,
    l.key               as license_key,
    l.status,
    l.expires_at
  from public.licenses l
  where l.owner_telegram_id is not null
  union all
  select
    a.telegram_id,
    a.username,
    'admin' as role,
    a.license_key,
    l.status,
    l.expires_at
  from public.admins a
  join public.licenses l on l.key = a.license_key;

-- ───────────────────────────────────────────────────────────────────────────
-- Web bulk-upload pipeline (Architecture A: Supabase Storage as the broker).
--
-- Access is granted by a TEMPORARY UPLOAD TOKEN (not a license key). A user with
-- bot access taps "Bulk upload"; the desktop app mints a token that is valid for
-- ~30 minutes and hands back a link containing it. The web page uploads files to
-- the `spoof-uploads` bucket and inserts a `spoof_jobs` row referencing the
-- token. The 24/7 desktop app (service_role) claims the job, spoofs each file,
-- uploads results to `spoof-outputs`, writes time-limited signed download URLs
-- onto the job row, DMs them to the requester, deletes the inputs, and deletes
-- everything once `expires_at` passes. Expired tokens can no longer create jobs.
-- ───────────────────────────────────────────────────────────────────────────

-- Short-lived upload links. Minted by the desktop app (service_role).
create table if not exists public.upload_tokens (
  token       uuid primary key,
  telegram_id bigint,           -- who requested it (for DM delivery of results)
  created_at  bigint not null,
  expires_at  bigint not null   -- token is unusable after this (≈ now + 30 min)
);
create index if not exists upload_tokens_expires_idx on public.upload_tokens (expires_at);
alter table public.upload_tokens enable row level security; -- no anon policies: service_role only

create table if not exists public.spoof_jobs (
  job_id       uuid primary key,
  license_key  text,            -- legacy; unused by the token flow
  upload_token uuid,            -- the temporary link that authorised this job
  telegram_id  bigint,
  status       text not null default 'queued', -- queued | processing | done | error
  total        int  not null default 0,
  completed    int  not null default 0,
  files        jsonb not null default '[]'::jsonb,
  error        text,
  created_at   bigint not null,
  updated_at   bigint not null,
  expires_at   bigint
);

-- Migration for projects created under the older license-gated flow.
alter table public.spoof_jobs add column if not exists upload_token uuid;
alter table public.spoof_jobs alter column license_key drop not null;

create index if not exists spoof_jobs_status_idx  on public.spoof_jobs (status, created_at);
create index if not exists spoof_jobs_expires_idx on public.spoof_jobs (expires_at);

alter table public.spoof_jobs enable row level security;

-- Security-definer check the browser can call to see whether a token is still
-- valid, WITHOUT being able to read the upload_tokens table directly.
create or replace function public.is_upload_token_valid(t uuid)
  returns boolean
  language sql
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.upload_tokens
    where token = t and expires_at > (extract(epoch from now()) * 1000)
  );
$$;

revoke all on function public.is_upload_token_valid(uuid) from public;
grant execute on function public.is_upload_token_valid(uuid) to anon;

-- Anonymous browsers may:
--   • INSERT a job only against a valid (unexpired) token, and only as 'queued';
--   • SELECT job progress (limited columns — no tokens/ids are exposed).
drop policy if exists "anon create job" on public.spoof_jobs;
create policy "anon create job"
  on public.spoof_jobs for insert to anon
  with check (public.is_upload_token_valid(upload_token) and status = 'queued');

drop policy if exists "anon read jobs" on public.spoof_jobs;
create policy "anon read jobs"
  on public.spoof_jobs for select to anon
  using (true);

-- PostgREST needs table privileges in addition to the RLS policies above.
-- Only progress columns are readable by anon; tokens and ids are never exposed.
grant insert on public.spoof_jobs to anon;
grant select (job_id, status, total, completed, files, error, created_at, expires_at)
  on public.spoof_jobs to anon;

-- Storage buckets (private). The desktop app uses service_role and bypasses RLS.
insert into storage.buckets (id, name, public)
  values ('spoof-uploads', 'spoof-uploads', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('spoof-outputs', 'spoof-outputs', false)
  on conflict (id) do nothing;

-- Browsers may only upload into the uploads bucket (paths are job-UUID scoped).
-- Outputs are downloaded exclusively via time-limited signed URLs, so no anon
-- read policy is granted on either bucket.
drop policy if exists "anon upload inputs" on storage.objects;
create policy "anon upload inputs"
  on storage.objects for insert to anon
  with check (bucket_id = 'spoof-uploads');
