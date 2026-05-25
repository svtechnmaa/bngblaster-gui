# Admin Guide — Operations, Setup, Troubleshooting

Practical cheatsheet for running BNGBlaster Web Client in dev or production. Pairs with `docs/DEPLOYMENT.md` (which covers hardening) and `docs/API.md` (endpoint reference).

---

## 1. Initial setup (first boot)

### 1.1 Prerequisites

- Docker Engine 24+ and Docker Compose v2
- `openssl` (for `SECRET_KEY`) and Python 3 with `cryptography` (for `FERNET_KEY`)
- Outbound network access to your BNGBlaster controllers (default port 8080) and SSH (22) for VLAN subinterface setup
- A GitHub fine-grained PAT if you will use the Git backup feature

### 1.2 Generate secrets

```bash
cd /opt/BNGBlaster_Web_Client
cp .env.example .env

# REQUIRED — JWT signing key
sed -i "s/change-me-to-a-32-byte-hex-string/$(openssl rand -hex 32)/" .env

# STRONGLY RECOMMENDED — Fernet key for encrypting SSH passwords + GitHub PAT at rest
FERNET=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
sed -i "s|^FERNET_KEY=.*|FERNET_KEY=${FERNET}|" .env
```

> **Do not rotate `FERNET_KEY` after data exists** — all existing `ssh_pass` and `git_token_enc` values become unreadable. See §9.4 for rotation procedure.

### 1.3 Start the stack

```bash
docker compose up -d --build
docker compose ps                 # all three services should be "running"
curl -s http://localhost:8001/health | jq   # {"status": "ok"}
```

| Endpoint | Purpose |
|---|---|
| `http://localhost:3001` | Web UI |
| `http://localhost:8001/docs` | Swagger / OpenAPI |
| `http://localhost:8001/health` | DB connectivity check |
| `localhost:5433` | Postgres (`bng_user` / `bng_pass`) |

### 1.4 First login — **change the default password immediately**

Default: `admin / admin123` (seeded on first start by `_seed_default_admin` in `backend/app/main.py`).

Web UI: **User Management → Edit admin → set new password**.

Or via API:

```bash
TOKEN=$(curl -s -X POST http://localhost:8001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.access_token')

# Find admin user id
curl -s http://localhost:8001/api/v1/auth/users \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | select(.username=="admin") | .id'

# Update password (substitute <ID> with the id from above)
curl -s -X PUT http://localhost:8001/api/v1/auth/users/<ID> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"password":"NEW_STRONG_PASSWORD"}'
```

---

## 2. Environment variables reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | ✅ | `bng_user` / `bng_pass` / `bng_web` | Postgres bootstrap creds |
| `SECRET_KEY` | ✅ | — | HS256 JWT signing key (32-byte hex). Changing invalidates all existing tokens. |
| `FERNET_KEY` | ⚠️ strongly recommended | — | Encrypts `bng_servers.ssh_pass` and `global_settings.git_token_enc`. Leave blank → values stored plaintext (back-compat only). |
| `DATABASE_URL` | ✅ (auto in compose) | `postgresql+psycopg2://bng_user:bng_pass@postgres:5432/bng_web` | DB DSN |
| `BNGBLASTER_BACKEND_URL` | | `http://localhost:8080` | Default controller URL shown in UI for new users |
| `FRONTEND_URL` | ✅ | `http://localhost:3001` | Used as the SSO redirect target — **must match the host the browser uses** |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | | blank | Set all three to enable Google SSO button |
| `KEYCLOAK_SERVER_URL` / `REALM` / `CLIENT_ID` / `CLIENT_SECRET` / `REDIRECT_URI` | | blank | Set all five to enable Keycloak SSO button |

Apply changes: `docker compose up -d backend` (restart backend picks up new env).

---

## 3. Day-to-day container ops

```bash
# Follow logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
docker compose logs --tail=200 backend   # last 200 lines

# Restart a single service after config change
docker compose up -d backend
docker compose up -d --build backend     # rebuild image first (e.g. after code change)

# Status
docker compose ps

# Hard reset DB (destructive — wipes all users/configs/servers)
docker compose down -v
docker compose up -d --build
# admin/admin123 is re-seeded on first startup
```

---

## 4. JWT curl workflow (for scripting / debugging)

```bash
# 1) Get a token
TOKEN=$(curl -s -X POST http://localhost:8001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | jq -r '.access_token')

# 2) Use it for subsequent requests
curl -s http://localhost:8001/api/v1/auth/me          -H "Authorization: Bearer $TOKEN" | jq
curl -s http://localhost:8001/api/v1/bngblaster/configs -H "Authorization: Bearer $TOKEN" | jq
curl -s http://localhost:8001/api/v1/dashboard/stats    -H "Authorization: Bearer $TOKEN" | jq

# POST / PUT / DELETE with body
curl -s -X POST http://localhost:8001/api/v1/bngblaster/configs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-cfg","description":"demo","config_json":{}}'

# Body from file (for large config_json)
curl -s -X POST http://localhost:8001/api/v1/bngblaster/configs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @my-config.json

# Print HTTP status code
curl -s -o /tmp/out.json -w 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8001/api/v1/auth/me
```

**Tokens expire after 24h** (`ACCESS_TOKEN_EXPIRE_MINUTES` in `core/config.py`). On 401, re-login.

Swagger UI (`/docs`) also has an **Authorize** button — paste the raw token (without `Bearer` prefix) to test endpoints interactively.

---

## 5. User & permission management

See `docs/RBAC.md` for the full matrix. Key rules:

- Roles: `admin > operator > viewer`. The seeded `admin` account cannot be deleted or demoted (UI + backend guard).
- Operators can edit/delete/start **only their own** configs. Admins can do anything to any config.
- New SSO sign-ups default to `role=operator` — an admin must promote/demote.

Create a user via API:

```bash
curl -s -X POST http://localhost:8001/api/v1/auth/register \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"Pass123!","email":"alice@ex.com","role":"operator"}'
```

---

## 6. BNG servers & SSH credentials

BNG server entries hold two things:

1. Controller endpoint — `host:port` used to proxy REST API calls to the BNGBlaster instance.
2. SSH credentials — used to create/delete VLAN subinterfaces on the test host when starting an instance (`setup-interfaces` endpoint).

Fields (admin-only):

```json
{
  "name": "test-bng-01",
  "host": "10.0.0.50",
  "port": 8080,
  "ssh_user": "root",
  "ssh_pass": "••••"
}
```

- `ssh_pass` is Fernet-encrypted at rest when `FERNET_KEY` is set.
- Test SSH connectivity before saving if possible — the backend uses `paramiko` via a thread executor and runs `ip link add ... type vlan id ...` (with `sudo` if the user is not root).
- If VLAN setup fails, the instance still starts if VLANs already exist on the host. Use `POST /bngblaster/servers/{id}/ssh-list-vlan-interfaces` to audit.

---

## 7. Config lifecycle

### 7.1 Name is globally unique

Creating or renaming a config with a name already in use → **HTTP 409 Conflict**. Cloning auto-suffixes `(copy)` / `(copy 2)` to avoid the collision. The Import flow retries with `(imported)` / `(imported 2)` suffixes.

### 7.2 Download / Export

Client-side only — the browser calls `GET /bngblaster/configs` and writes a `.json` file via `Blob`. Three variants in the UI:

- **Download row icon** — single config (raw `config_json`).
- **Export All** — wrapped bundle `{exported_at, format, configs: [...]}` for round-trip import.
- Admins and operators can both export; viewers can download single configs they can already read.

### 7.3 Import

Upload `.json`. The client auto-detects:
- Raw `config_json` → prompts for a name.
- Exported bundle → imports every entry, retrying on 409.

### 7.4 Git backup (admin-only, bulk)

See §8 below.

---

## 8. Git backup setup

One-time setup:

1. **Create a GitHub repo** (empty or existing) that will hold the backups.
2. **Generate a fine-grained PAT** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: only the backup repo.
   - Repository permissions: **Contents → Read and write**, **Metadata → Read**.
3. In the web UI (logged in as admin): **Admin Settings** menu →
   - **Repo URL** — `https://github.com/{owner}/{repo}` or `git@github.com:{owner}/{repo}`.
   - **Branch** — defaults to `main`.
   - **PAT** — paste once; stored Fernet-encrypted (needs `FERNET_KEY` for at-rest encryption to mean anything).
4. Click **Test connection** to verify PAT validity + push permission.
5. Click **Backup now** — pushes every `bng_configs` row.

Layout in the repo:

```
configs/
  {owner_username}/
    {safe_name}.json       # raw config_json, directly runnable by the BNGBlaster CLI
    {safe_name}.meta.json  # name, description, owner, timestamps
```

Unchanged files are skipped (GitHub sha match). Response aggregates `{created, updated, unchanged, failed}`.

Rotate / clear the PAT:

```bash
# Replace with a new PAT (empty git_token is NOT sent → existing token preserved)
curl -s -X PUT http://localhost:8001/api/v1/admin/settings/git \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"git_token":"ghp_newtoken..."}'

# Explicitly CLEAR the stored PAT (send empty string)
curl -s -X PUT http://localhost:8001/api/v1/admin/settings/git \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"git_token":""}'
```

---

## 9. Troubleshooting

### 9.1 HTTP error cheat sheet

| Status | Likely cause | Fix |
|---|---|---|
| **401 Unauthorized** | JWT expired (>24h), wrong token, or `SECRET_KEY` changed | Re-login |
| **403 Forbidden** | Role not high enough (e.g. operator hitting `/admin/*`) | Promote role or use admin account |
| **409 Conflict** | Duplicate config `name` (globally unique) | Rename, or let Import auto-suffix |
| **400 on `/admin/settings/git/test`** | Invalid PAT, revoked, or missing Contents:write | Regenerate PAT with correct scopes |
| **400 on config `_start`** | VLAN setup SSH failed | See §9.2 |
| **500** on any endpoint | Usually DB connectivity — check `docker compose logs backend` | See §9.3 |

### 9.2 "VLAN setup failed" when starting an instance

Order of operations: `_start` parses VLANs from `config_json` → SSHes to BNG host → `ip link add ...`. Common failures:

- **Auth failed** — SSH creds in `bng_servers` wrong or stored plaintext after `FERNET_KEY` rotation. Edit the server, re-enter the password.
- **Permission denied** on `ip link` — non-root SSH user without passwordless sudo. Either use root, or configure `NOPASSWD: ALL` in `/etc/sudoers.d/bng` on the BNG host.
- **VLAN already exists** — harmless; `ip link add` returns exit 2. Backend logs the message but still proceeds with the controller `PUT`.

Audit existing VLANs:

```bash
curl -s -X POST http://localhost:8001/api/v1/bngblaster/servers/<id>/ssh-list-vlan-interfaces \
  -H "Authorization: Bearer $TOKEN"
```

### 9.3 DB connectivity / `/health` returns `error`

```bash
# Is postgres container alive?
docker compose ps postgres

# Can backend reach it?
docker compose exec backend python -c \
  "from app.core.database import engine; from sqlalchemy import text; \
   print(engine.connect().execute(text('SELECT 1')).scalar())"

# Logs
docker compose logs --tail=100 postgres
docker compose logs --tail=100 backend | grep -i 'psycopg\|sqlalchemy\|connection'
```

Typical causes: volume permission issues (SELinux), `POSTGRES_PASSWORD` changed after volume init (Postgres keeps the old password inside `pgdata` — must nuke the volume or reset inside psql).

### 9.4 `FERNET_KEY` lost or rotated

Symptom: previously saved `ssh_pass` and Git PAT silently decrypt to garbage (the `decrypt_secret` helper catches exceptions and returns the raw ciphertext as-is), so SSH auth and GitHub auth fail with opaque errors.

**Rotation is NOT automatic.** You must:

1. Back up the DB (§10).
2. With the OLD `FERNET_KEY` still live: dump out the secrets (or re-enter them via UI to get plaintext back).
3. Set the NEW `FERNET_KEY` in `.env` and restart backend.
4. Re-enter every SSH password (via **Edit server**) and the Git PAT (via **Admin Settings**).

If the old key is lost: the same procedure but step 2 is impossible — admins must re-collect credentials from source-of-truth.

### 9.5 SSO callback fails / infinite redirect

Symptom: after clicking "Sign in with Google" the browser ends up back on `/login` or sees a JSON error.

Checks:

- **Redirect URI mismatch** — `GOOGLE_REDIRECT_URI` in `.env` MUST be exactly one of the authorized URIs in Google Cloud Console (down to trailing slash + scheme). Same for Keycloak.
- **`FRONTEND_URL` wrong** — the backend 302s to `{FRONTEND_URL}/oauth-callback?token=...`. If users access the UI through a different host (reverse proxy, LAN IP vs `localhost`), change `FRONTEND_URL` to match.
- **Scopes** — Google flow requests `openid email profile`. If the user denies `email`, the email-based account linking (§_upsert logic_) falls back to creating a brand-new user.
- **Keycloak TLS** — `sso.py:201` uses `httpx.AsyncClient(verify=False)` for back-compat. In production with a proper CA chain, flip to `verify=True`.

### 9.6 `admin` account missing / locked out

If the `admin` row was deleted (by an admin with DB access) the startup seeder re-creates it ONLY if `username='admin'` is absent. Fastest recovery:

```bash
docker compose exec postgres psql -U bng_user -d bng_web \
  -c "DELETE FROM users WHERE username='admin';"
docker compose restart backend   # seeder runs again → admin/admin123 recreated
```

If the row still exists but the password is forgotten, reset it directly:

```bash
docker compose exec backend python - <<'PY'
from app.core.database import SessionLocal
from app.core.security import get_password_hash
from app.models.user import User
db = SessionLocal()
u = db.query(User).filter(User.username=="admin").first()
u.password_hash = get_password_hash("admin123")
db.commit(); print("reset")
PY
```

### 9.7 Ruff / eslint pre-commit failures

Project uses Ruff for Python. Common fixes:

```bash
cd backend
ruff check .             # show issues
ruff check . --fix       # auto-fix what's safe
ruff format .            # apply formatting
```

Frontend: `cd frontend && npm run lint`.

---

## 9.8 Nginx (frontend container) — ops and debug

The `frontend` container runs Nginx 1.27 serving the pre-built SPA and proxying `/api/` to the backend. Config lives at `frontend/nginx.conf` and is baked into the image at build time — editing the file on the host has no effect until you rebuild or bind-mount it.

### Quick checks

```bash
# Access + error logs
docker compose logs -f frontend
docker compose logs --tail=200 frontend | grep -iE 'error|warn'

# Shell into container
docker compose exec frontend sh

# Verify active config
docker compose exec frontend cat /etc/nginx/conf.d/default.conf

# Syntax test (does NOT reload)
docker compose exec frontend nginx -t

# Does Nginx still see the backend?
docker compose exec frontend wget -qO- http://backend:8000/health
```

### Apply config changes

```bash
# Option A — normal path (recommended): rebuild the frontend image
docker compose up -d --build frontend

# Option B — live edit without rebuild (dev convenience)
# Mount nginx.conf as a volume in docker-compose.yml:
#   frontend:
#     volumes:
#       - ./frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro
# Then after editing:
docker compose exec frontend nginx -s reload
```

### Common tweaks

| Change | Where |
|---|---|
| Move host port 3001 → elsewhere | `docker-compose.yml` `frontend.ports` (`"3001:80"`) |
| Longer proxy timeout (for slow SSH / controller ops) | `frontend/nginx.conf` → `proxy_read_timeout` |
| Add security headers (X-Frame-Options, CSP, HSTS) | add `add_header` inside the `server {}` block |
| Enable gzip / brotli | add `gzip on; gzip_types text/css application/javascript ...;` |
| Terminate TLS directly in this Nginx | switch `listen 80` → `listen 443 ssl;`, mount cert+key, expose 443 in compose |
| Serve an extra static path (e.g. `/uploads/`) | add a new `location` block with `root` or `alias` |

### Typical failure modes

| Symptom | Likely cause |
|---|---|
| `502 Bad Gateway` on `/api/*` | `backend` container down / unhealthy. `docker compose ps`, `docker compose logs backend`. |
| `504 Gateway Timeout` on a long controller/SSH call | `proxy_read_timeout` too low — bump from 300s. |
| F5 at `/admin/settings` returns 404 | `try_files ... /index.html` missing or path wrong (check `root` + the `location /` block). |
| After rebuilding backend, UI shows stale 502s for ~10s | Expected — embedded DNS has `valid=10s`. It recovers automatically. |
| CORS errors in browser console | Someone bypassed Nginx and called `http://host:8001` directly from the SPA. The SPA must use same-origin `/api/...`. |

### Dev mode note

`npm run dev` **does not use Nginx** — Vite serves and proxies via `vite.config.ts`. So any Nginx-specific config (headers, rate-limit, gzip) only applies to the Docker-built production image.

---

## 10. Backup & recovery

### 10.1 Postgres volume

All state lives in the `bngweb_pgdata` named volume. Snapshot regularly:

```bash
# Hot backup (SQL dump)
docker compose exec -T postgres pg_dump -U bng_user -d bng_web \
  > backup-$(date +%F).sql

# Restore
docker compose exec -T postgres psql -U bng_user -d bng_web < backup-2026-04-16.sql
```

### 10.2 Git backup (configs only)

`/admin/settings` → **Backup now** dumps every config to GitHub. Good for config versioning and cross-env sync, not a full DR backup (users, servers, settings are NOT included).

### 10.3 `.env` and `FERNET_KEY`

Back up `.env` securely (password manager, vault). **Losing `FERNET_KEY` = losing every encrypted SSH password and Git PAT**. `SECRET_KEY` loss "only" invalidates active JWTs (users re-login).

---

## 11. Security checklist for production

- [ ] `SECRET_KEY` generated with `openssl rand -hex 32`, stored in secret manager
- [ ] `FERNET_KEY` generated and set (not blank)
- [ ] Default `admin/admin123` password changed
- [ ] TLS-terminating reverse proxy (Nginx/Caddy) in front of ports 3001/8001 — see `docs/DEPLOYMENT.md`
- [ ] Postgres port (`5433:5432`) NOT exposed on the public interface in production compose
- [ ] SSO redirect URIs pinned to the HTTPS hostname (not `localhost`)
- [ ] GitHub PAT is fine-grained, scoped to the backup repo only, rotated every 90 days
- [ ] `bngweb_pgdata` volume backed up on a schedule
- [ ] `.env` file permissions `600`, owned by the deploy user
- [ ] Review logs (`docker compose logs backend`) for repeated 401/403 — possible brute-force
