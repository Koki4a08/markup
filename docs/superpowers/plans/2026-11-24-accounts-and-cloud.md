# Accounts and cloud

Plan for optional accounts shared by the website, the editor (web + desktop) and the Chrome extension, backed by one Supabase project.

## Decisions

- Accounts are optional. Everything that works without an account today keeps working without one, forever (local-first, no MCP limits).
- Every account feature is free: cloud backup and sync, share links, comments from others, multiplayer, remote MCP, version history, personal usage stats.
- The only limit is cloud storage: **500 MB free**, **20 GB for €9.99/month**.
- Hitting the limit never blocks editing and never deletes data. New uploads pause and the file shows "Local only". After a cancelled subscription the cloud goes read-only until the user is under 500 MB again; everything stays downloadable.
- One Supabase project in an EU region (Frankfurt) for GDPR.
- `supabase/` (migrations + Edge Functions) is private: kept out of the public repo (gitignored) and deployed from the maintainer's machine.
- Payments: Paddle as Merchant of Record so it handles EU VAT. (Recommended; not confirmed yet. Stripe + Stripe Tax is the alternative.)

## Secrets

- Server only (Supabase secrets / Vercel env, never in the repo, never `VITE_*`, never in the Tauri binary or the extension): `SUPABASE_SERVICE_ROLE_KEY`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`.
- Public by design (shipped in clients): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Protection comes from RLS.
- Anything that needs a secret runs in an Edge Function that verifies the caller's JWT and ownership.
- Before the first `.env`: add `.env*` to `.gitignore`, enable GitHub secret scanning + push protection.

## Architecture

```
markup.here (Vercel)  ─┐
Editor web + Tauri    ─┼─►  Supabase (EU)
Extension             ─┘     ├─ Auth: GitHub, Google, email magic link
                             ├─ Postgres + RLS
                             ├─ Storage: bucket "files"
                             └─ Edge Functions (hold the secrets)
Paddle ── webhook ──► Edge Function
```

### Sync (phase 1, no extra server)

Files are already Yjs docs (`apps/app/src/workspace/persistence.ts`: one `Y.Doc` per `fileId`, plus the library doc). Yjs merges states without conflicts, so:

- On change (debounced): `Y.encodeStateAsUpdate(doc)` → upload to `files/{userId}/{fileId}/state.bin`.
- On open: download the cloud state and `Y.applyUpdate` it into the local doc. Two devices merge automatically.
- Comments and the agent log live inside the doc, so they sync with it.
- Real-time multiplayer (Hocuspocus) needs a long-running Node server (Fly or Hetzner); Vercel cannot hold WebSockets. Later milestone.

Storage paths:

```
files/{userId}/{fileId}/state.bin
files/{userId}/{fileId}/assets/{sha256}
files/{userId}/{fileId}/history/{timestamp}.bin
files/{userId}/library.bin
```

### Database

| Table | Columns | Written by |
|---|---|---|
| `profiles` | id (= auth.users.id), display_name, avatar_url | owner |
| `cloud_files` | id (= fileId), owner_id, name, folder_id, size_bytes, updated_at, deleted_at | owner |
| `user_settings` | user_id, data jsonb, updated_at | owner |
| `share_links` | id, file_id, token_hash, role (view/comment/edit), expires_at, created_by | owner |
| `usage_daily` | user_id, day, device_id, client (desktop/web/extension), metrics jsonb | owner (upsert) |
| `subscriptions` | user_id, provider_customer_id, provider_subscription_id, status, current_period_end | webhook only (service role) |

- RLS on every table, owner-scoped (`auth.uid() = owner_id`). `storage_usage` and `subscriptions` are read-only to clients.
- `user_quota(uid)` returns 500 MiB, or 20 GiB while the subscription is active (internal). Clients call `my_storage()` for usage and quota.
- Usage is summed from `storage.objects` on demand (no counter table), so it cannot drift.
- Index every FK and filter column (`owner_id`, `file_id`, `(user_id, day)`).

### Quota (enforced server-side)

1. Client calls Edge Function `request-upload` with the byte size.
2. It checks `storage_bytes_used(uid) + size <= user_quota(uid)` and returns a signed upload URL. No direct uploads (storage policies allow clients only to read and delete their own folder).
3. Over quota: uploads are refused, the UI shows "Local only", editing and existing cloud files keep working.
4. `usage_daily` is tiny and does not count toward the quota.

### Sign-in per client

- Website: `/login/` and `/signup/` (email + password, magic link, GitHub, password reset). Other pages are not decided yet.
- Web editor: same Supabase client, normal redirect.
- Desktop (built): "Sign in" opens `markup.here/login/?client=desktop&challenge=…&state=…`. A Supabase PKCE code from the site's login cannot be exchanged by the app (its verifier lives in the browser), and passing the browser's tokens would share one refresh token between two clients. So the site asks the `desktop-auth` Edge Function for a one-time code bound to the app's challenge, opens `markup://auth/callback?code=…&state=…`, and the app trades code + verifier for a magic-link token hash and calls `verifyOtp`: a session of its own. Details in the private backend's README. The session is AES-GCM encrypted in the webview's storage with the key in the OS credential store (Credential Manager caps a secret at 2.5 KB, too small for a session).
- Extension: `chrome.identity.launchWebAuthFlow` with PKCE; add `https://<extension-id>.chromiumapp.org/` to the Supabase redirect allow list.

### Payments

- "Upgrade" → Edge Function `create-checkout` → Paddle checkout with `user_id` in custom data.
- Paddle → `paddle-webhook` Edge Function → verify signature → upsert `subscriptions` with the service role.
- Account page links to the Paddle customer portal for cancel and invoices.

## Personal usage stats

Stats exist for the user. They are not used for tracking, ads or marketing. Where they are shown is not decided yet (no pages are decided yet).

- Counted locally in the client into daily rollups (IndexedDB `markup:usage`). No raw event stream, no file content, no page URLs, no prompts.
- Signed in: rollups upsert into `usage_daily` (one row per user, day and device). Signed out: they stay local only.
- Setting "Save my usage stats" (on by default for accounts), plus "Delete my stats" on the account page.
- Agent tool calls are counted in one place: the bridge handlers in `apps/app/src/bridge/`.

Metrics (per day):

| Metric | Source |
|---|---|
| Active minutes (focused window with input in the last minute) | editor |
| Files created / edited | workspace |
| Layers and artboards created, by human vs agent | doc ops (agent log already attributes actors) |
| Agent tool calls, by agent client and by tool | bridge |
| Exports, by format | export pipeline |
| Snapshots captured | extension |
| Comments written | comments |
| Cloud storage used | `storage_usage` (daily snapshot) |

## Privacy and GDPR

- Update `markup-website/src/content/legal.ts` before anything ships: accounts are optional, what is stored and why, personal usage stats (owner-only, deletable), Supabase and Paddle as processors, EU region, export and delete.
- Delete account: Edge Function removes the user's Storage objects, rows and the auth user.
- Update the Chrome Web Store data disclosure when the extension starts sending data.
- Add a changelog entry for every release that ships part of this.

## Milestones

- [ ] **M1**: Supabase project (EU), `supabase/` migrations + RLS (written), `.gitignore` (done) + push protection, website `/login/` and `/signup/` (written), privacy page update (written)
- [ ] **M2**: Sign-in in the editor (desktop done: deep link handoff, encrypted session, account button; web editor and settings sync still open)
- [ ] **M3**: Cloud backup and sync, quota, storage usage UI
- [ ] **M4**: Personal usage stats (local rollups, upload)
- [ ] **M5**: Share links + web viewer (view, comment)
- [ ] **M6**: Paddle checkout + webhook, 20 GB plan
- [ ] **M7**: Hocuspocus multiplayer, remote MCP for cloud agents
