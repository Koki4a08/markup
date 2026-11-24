-- Billing: the paid plan only buys cloud storage (500 MB free, 20 GB paid). No feature is gated.
-- Rows are written by the payment webhook (Edge Function, service role). Clients can only read their own.

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null default 'paddle' check (provider in ('paddle', 'stripe')),
  provider_customer_id text not null,
  provider_subscription_id text not null unique,
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is 'One row per paying user. Written only by the payment webhook.';

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

create policy "subscriptions: owner reads"
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

-- Webhook idempotency: every processed provider event id, so a retried delivery is skipped.
create table public.billing_events (
  id text primary key,
  provider text not null,
  type text not null,
  received_at timestamptz not null default now()
);

comment on table public.billing_events is 'Processed webhook event ids. Service role only.';

alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;

-- Storage quota in bytes: 20 GiB while a subscription is active (past_due is a grace period), else 500 MiB.
-- Internal: takes any user id, so clients cannot call it. Clients use public.my_storage().
create function public.user_quota(uid uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.subscriptions s
      where s.user_id = uid and s.status in ('trialing', 'active', 'past_due')
    ) then 21474836480::bigint -- 20 GiB
    else 524288000::bigint      -- 500 MiB
  end;
$$;

revoke execute on function public.user_quota(uuid) from public, anon, authenticated;
