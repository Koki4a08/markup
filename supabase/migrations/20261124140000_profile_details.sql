-- Profile details collected on the sign-up form: first and last name (required on the form),
-- role and team size (optional). Signup sends them as user metadata; the trigger copies only
-- allowed values, so a crafted signup can never fail or store junk.

alter table public.profiles
  add column first_name text check (char_length(first_name) between 1 and 80),
  add column last_name text check (char_length(last_name) between 1 and 80),
  add column role text check (
    role in ('designer', 'developer', 'design_engineer', 'product_manager', 'founder', 'student', 'other')
  ),
  add column team_size text check (team_size in ('just_me', '2_10', '11_50', '51_200', '200_plus'));

comment on column public.profiles.role is 'What the user does. Optional, asked on sign-up.';
comment on column public.profiles.team_size is 'How many people the user works with. Optional, asked on sign-up.';

grant update (first_name, last_name, role, team_size) on public.profiles to authenticated;

-- Replaces the signup trigger function from 20261124120000_accounts.sql.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  first_v text := left(nullif(btrim(meta ->> 'first_name'), ''), 80);
  last_v text := left(nullif(btrim(meta ->> 'last_name'), ''), 80);
  role_value text := meta ->> 'role';
  team_value text := meta ->> 'team_size';
begin
  insert into public.profiles (id, display_name, avatar_url, first_name, last_name, role, team_size)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(concat_ws(' ', first_v, last_v)), ''),
        nullif(meta ->> 'full_name', ''),
        nullif(meta ->> 'name', ''),
        nullif(meta ->> 'user_name', ''),
        split_part(new.email, '@', 1)
      ),
      80
    ),
    left(nullif(meta ->> 'avatar_url', ''), 2048),
    first_v,
    last_v,
    case when role_value in ('designer', 'developer', 'design_engineer', 'product_manager', 'founder', 'student', 'other')
      then role_value end,
    case when team_value in ('just_me', '2_10', '11_50', '51_200', '200_plus') then team_value end
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
