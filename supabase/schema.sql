-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).

create table if not exists public.site_content (
  id text primary key default 'main',
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_content_backups (
  id bigserial primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.site_content enable row level security;
alter table public.site_content_backups enable row level security;

-- No public policies: the server uses the service-role key, which bypasses RLS.
comment on table public.site_content is 'Single-row site CMS payload for the MPC website';
comment on table public.site_content_backups is 'Timestamped snapshots taken before each admin save';
