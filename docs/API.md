# API Reference

All endpoints are prefixed with `/api/v1`. Auth: `Authorization: Bearer <jwt>` (obtained from `/auth/login` or SSO callback). Swagger UI: `/docs`.

## Auth (`/auth`)

| Method | Path | Auth | Body | Description |
|---|---|---|---|---|
| `POST` | `/auth/login` | — | `{username, password}` | Returns `{access_token, user}` |
| `GET`  | `/auth/me` | user | — | Current user info |
| `GET`  | `/auth/providers` | — | — | `{local, google, keycloak}` enabled flags |
| `POST` | `/auth/register` | admin | `UserCreate` | Create user |
| `GET`  | `/auth/users` | admin | — | List all users |
| `PUT`  | `/auth/users/{id}` | admin | `UserUpdate` | Update role / active / email / name |
| `DELETE` | `/auth/users/{id}` | admin | — | Delete (cannot delete `admin` or self) |

## SSO (`/auth/{provider}`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/google/login` | — | Returns `{auth_url}` to redirect browser to |
| `GET` | `/auth/google/callback?code=...` | — | Exchanges code, upserts user, 302 → `FRONTEND_URL/oauth-callback?token=...&user=...` |
| `GET` | `/auth/keycloak/login` | — | Same shape as Google |
| `GET` | `/auth/keycloak/callback?code=...` | — | Same shape as Google |

## Settings (`/settings`)

| Method | Path | Auth | Body | Description |
|---|---|---|---|---|
| `GET` | `/settings` | user | — | Per-user overrides (bngblaster_url, bng_ssh_user, bng_ssh_pass) |
| `PUT` | `/settings` | user | partial dict | Update only provided keys |

## BNGBlaster (`/bngblaster`)

### Schema

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/bngblaster/schema` | — | `all_conf.yml` parsed as JSON for the visual builder |

### BNG Servers

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`    | `/bngblaster/servers` | user | List all servers |
| `POST`   | `/bngblaster/servers` | admin | Create `{name, host, port, ssh_user, ssh_pass}` |
| `PUT`    | `/bngblaster/servers/{id}` | admin | Update fields |
| `DELETE` | `/bngblaster/servers/{id}` | admin | Delete |
| `POST`   | `/bngblaster/servers/{id}/setup-interfaces` | user | Body `{config_json}` — extract VLANs, create via SSH |
| `POST`   | `/bngblaster/servers/{id}/ssh-list-vlan-interfaces` | user | List existing VLAN ifaces on host |
| `POST`   | `/bngblaster/servers/{id}/cleanup-interfaces` | user | Body `{interfaces: [...]}` — delete via SSH |

### BNG Configs

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`    | `/bngblaster/configs` | user | All configs (own first, with `is_owner` flag) |
| `POST`   | `/bngblaster/configs` | operator+ | Create — **409 Conflict** if `name` is already used (globally unique) |
| `POST`   | `/bngblaster/configs/{id}/clone` | user | Clone any config as current user; the new name is auto-suffixed `(copy)` / `(copy N)` to stay unique |
| `PUT`    | `/bngblaster/configs/{id}` | owner OR admin | Update — **409 Conflict** if rename collides with another config |
| `DELETE` | `/bngblaster/configs/{id}` | owner OR admin | Delete |

**Name uniqueness:** enforced in application code (no DB `UNIQUE` index). Frontend pre-checks against the already-loaded list and disables Save with an inline warning; the server is still the source of truth and returns 409 on collision. The Import flow auto-retries with `(imported)` / `(imported 2)` suffixes when it encounters a 409.

### Instance proxy (proxies BNGBlaster controller REST)

| Method | Path | Description |
|---|---|---|
| `GET`    | `/bngblaster/servers/{sid}/version` | Controller version |
| `GET`    | `/bngblaster/servers/{sid}/interfaces` | Available NICs on the BNG host |
| `GET`    | `/bngblaster/servers/{sid}/instances` | Instance names + running set (normalized) |
| `GET`    | `/bngblaster/servers/{sid}/instances-with-status` | `[{name, status}]` (parallel fetch) |
| `GET`    | `/bngblaster/servers/{sid}/instances/{name}/status` | Single instance status |
| `GET`    | `/bngblaster/servers/{sid}/instances/{name}/config` | Active `config.json` |
| `PUT`    | `/bngblaster/servers/{sid}/instances/{name}/config` | Push config |
| `DELETE` | `/bngblaster/servers/{sid}/instances/{name}` | Delete instance |
| `POST`   | `/bngblaster/servers/{sid}/instances/{name}/start` | `_start` only (config must already exist) |
| `POST`   | `/bngblaster/servers/{sid}/instances/{name}/_start` | Push `config_json` then start |
| `POST`   | `/bngblaster/servers/{sid}/instances/{name}/stop` | Graceful stop |
| `POST`   | `/bngblaster/servers/{sid}/instances/{name}/kill` | Force kill |
| `POST`   | `/bngblaster/servers/{sid}/instances/{name}/command` | Send ctrl-socket command |
| `GET`    | `/bngblaster/servers/{sid}/instances/{name}/log` | Download `run.log` |
| `GET`    | `/bngblaster/servers/{sid}/instances/{name}/report` | Download `run_report.json` |
| `GET`    | `/bngblaster/servers/{sid}/instances/{name}/files/{file_name}` | Generic file download |

## Metrics & Dashboard (`/metrics`, `/dashboard`)

| Method | Path | Auth | Body | Description |
|---|---|---|---|---|
| `POST` | `/metrics/pageview` | user | `{path?: string}` | Record a page view for the current user (204 No Content). F5/reload each counts as 1. Fired by `PageviewTracker` on every SPA route change. |
| `GET`  | `/dashboard/stats`  | user | — | Role-aware aggregates for the Dashboard tab. Base payload: `{totals: {users, servers, configs, pageviews_7d, pageviews_30d}, pageviews_daily: [{date, count}], own_configs, role}`. For `admin`/`operator`, extra fields: `users_by_role`, `users_by_provider`, `top_config_owners`, `active_users_7d`. |

## Admin Settings (`/admin/settings`)

All endpoints require `role = admin` (403 otherwise). The PAT is Fernet-encrypted at rest and never returned in plaintext.

| Method | Path | Body | Description |
|---|---|---|---|
| `GET`  | `/admin/settings/git` | — | `{git_repo_url, git_branch, git_token_set: bool, updated_at}` |
| `PUT`  | `/admin/settings/git` | `{git_repo_url?, git_branch?, git_token?}` | Save config. An empty string for `git_token` **clears** it; omitting the key **keeps** the existing one. Invalid URL → 400. |
| `POST` | `/admin/settings/git/test` | — | Hits `GET /user` and `GET /repos/{owner}/{repo}` on GitHub; returns `{ok, github_user, owner, repo, branch, default_branch}`. 400 on bad creds, 403 if PAT lacks push permission. |
| `POST` | `/admin/settings/git/backup` | — | Pushes every `bng_configs` row to the repo. Creates `configs/{owner_username}/{safe_name}.json` + `.meta.json` sidecar via the GitHub Contents API (sha-based update, skips unchanged files). Returns `{repo, branch, total, created, updated, unchanged, failed, details: [{name, owner, status, error?}], timestamp}`. |

Accepted repo URL forms: `https://github.com/{owner}/{repo}[.git]` or `git@github.com:{owner}/{repo}[.git]`.

## Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{status: ok\|error}` (DB connectivity check) |
| `GET` | `/` | App name + version |
