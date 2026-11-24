-- Personal usage stats: daily rollups counted on the client, one row per user, day and device.
-- For the user only: no file content, names, URLs or prompts. Small, does not count toward the quota.

create table public.usage_daily (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  -- Random id the client generates once per install; not tied to hardware.
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  client text not null check (client in ('desktop', 'web', 'extension')),
  -- Counters, e.g. {"active_minutes": 42, "exports": {"png": 3}, "agent_calls": {"claude-code": 120}}.
  metrics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 16384),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, device_id)
);

comment on table public.usage_daily is 'Daily usage counters for the user''s own stats. Owner-only, deletable.';

create trigger usage_daily_updated_at
  before update on public.usage_daily
  for each row execute function public.set_updated_at();

alter table public.usage_daily enable row level security;

create policy "usage_daily: owner reads"
  on public.usage_daily for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "usage_daily: owner inserts"
  on public.usage_daily for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "usage_daily: owner updates"
  on public.usage_daily for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "usage_daily: owner deletes"
  on public.usage_daily for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.usage_daily from anon, authenticated;
grant select, insert (day, device_id, client, metrics), update (day, device_id, client, metrics), delete
  on public.usage_daily to authenticated;
