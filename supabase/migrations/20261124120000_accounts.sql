-- Accounts: one profile per auth user, plus per-user settings.
-- Every table: RLS on, owner-scoped policies, no access for `anon`, explicit column grants.

-- Shared trigger: keep updated_at current on every update.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  avatar_url text check (char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Public face of an account: the name and avatar shown on comments, cursors and the agent log.';

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles: owner reads"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: owner updates"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Rows are created by the signup trigger only; clients edit the name and avatar, nothing else.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- ── user_settings ───────────────────────────────────────────────────────────

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 65536),
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is 'Editor settings synced across devices (theme, shortcuts, swatches). Max 64 KB.';

create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;

create policy "user_settings: owner reads"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "user_settings: owner inserts"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "user_settings: owner updates"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.user_settings from anon, authenticated;
grant select, insert (user_id, data), update (user_id, data) on public.user_settings to authenticated;

-- ── signup ──────────────────────────────────────────────────────────────────

-- Creates the profile when an auth user is created (email signup, magic link or GitHub).
-- Name and avatar come from the OAuth profile when there is one, else the email's local part.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(
      coalesce(
        nullif(new.raw_user_meta_data ->> 'full_name', ''),
        nullif(new.raw_user_meta_data ->> 'name', ''),
        nullif(new.raw_user_meta_data ->> 'user_name', ''),
        split_part(new.email, '@', 1)
      ),
      80
    ),
    left(nullif(new.raw_user_meta_data ->> 'avatar_url', ''), 2048)
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
