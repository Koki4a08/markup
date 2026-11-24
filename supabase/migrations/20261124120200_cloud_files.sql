-- Cloud files: opt-in backup and sync of local Markup files, share links, and the storage quota.
--
-- Storage layout (bucket "files", private):
--   {user_id}/library.bin                    the file and folder tree (Yjs)
--   {user_id}/{file_id}/state.bin            one file's Yjs state
--   {user_id}/{file_id}/assets/{sha256}      images and fonts used by that file
--   {user_id}/{file_id}/history/{ts}.bin     version history snapshots
--
-- Clients can read and delete objects under their own folder, never write directly: uploads go
-- through an Edge Function that checks the quota and hands out a signed upload URL.
-- Usage is summed from storage.objects on demand, so it can never drift from what is stored.

-- ── cloud_files ─────────────────────────────────────────────────────────────

create table public.cloud_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The local file id (nanoid), which is also its folder name in storage.
  file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, file_id)
);

comment on table public.cloud_files is 'Files a user chose to keep in the cloud. Content lives in storage under {owner_id}/{file_id}/.';

create trigger cloud_files_updated_at
  before update on public.cloud_files
  for each row execute function public.set_updated_at();

alter table public.cloud_files enable row level security;

create policy "cloud_files: owner reads"
  on public.cloud_files for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "cloud_files: owner inserts"
  on public.cloud_files for insert to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "cloud_files: owner updates"
  on public.cloud_files for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "cloud_files: owner deletes"
  on public.cloud_files for delete to authenticated
  using ((select auth.uid()) = owner_id);

revoke all on public.cloud_files from anon, authenticated;
grant select, insert (file_id, name), update (name, deleted_at), delete on public.cloud_files to authenticated;

-- ── share_links ─────────────────────────────────────────────────────────────

-- The link carries a random token; only its SHA-256 is stored. Opening a link is resolved by an
-- Edge Function (service role), so visitors never query this table.
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.cloud_files (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null default 'view' check (role in ('view', 'comment', 'edit')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.share_links is 'Links that open a cloud file for people without access. Token stored as SHA-256 only.';

create index share_links_file_id_idx on public.share_links (file_id);
create index share_links_created_by_idx on public.share_links (created_by);

alter table public.share_links enable row level security;

-- A link may only point at a file its creator owns.
create policy "share_links: owner reads"
  on public.share_links for select to authenticated
  using ((select auth.uid()) = created_by);

create policy "share_links: owner creates for own files"
  on public.share_links for insert to authenticated
  with check (
    (select auth.uid()) = created_by
    and exists (
      select 1 from public.cloud_files f
      -- Qualified: inside this subquery a bare file_id would mean cloud_files.file_id.
      where f.id = share_links.file_id and f.owner_id = (select auth.uid())
    )
  );

create policy "share_links: owner updates"
  on public.share_links for update to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by);

create policy "share_links: owner deletes"
  on public.share_links for delete to authenticated
  using ((select auth.uid()) = created_by);

revoke all on public.share_links from anon, authenticated;
grant select, insert (file_id, token_hash, role, expires_at), update (role, expires_at, revoked_at), delete
  on public.share_links to authenticated;

-- ── storage bucket ──────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 104857600) -- 100 MB per object
on conflict (id) do nothing;

create policy "files: owner reads own folder"
  on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "files: owner deletes own folder"
  on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ── quota ───────────────────────────────────────────────────────────────────

-- Bytes a user has in the files bucket. Internal: takes any user id. Clients use my_storage().
create function public.storage_bytes_used(uid uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'files' and o.name like uid::text || '/%';
$$;

revoke execute on function public.storage_bytes_used(uuid) from public, anon, authenticated;

-- The signed-in user's usage and quota, in bytes.
create function public.my_storage()
returns table (bytes_used bigint, quota_bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select public.storage_bytes_used(auth.uid()), public.user_quota(auth.uid())
  where auth.uid() is not null;
$$;

revoke execute on function public.my_storage() from public, anon;
grant execute on function public.my_storage() to authenticated;
