# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Full stack (docker)
```bash
cp .env.example .env
sed -i "s/change-me-to-a-32-byte-hex-string/$(openssl rand -hex 32)/" .env
docker compose up -d --build     # UI :3001, API :8001, Postgres :5433
```

### Backend (FastAPI)
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SECRET_KEY=$(openssl rand -hex 32) \
DATABASE_URL=postgresql+psycopg2://bng_user:bng_pass@localhost:5433/bng_web \
  uvicorn app.main:app --reload --port 8001
```
No test suite is configured. Swagger: `http://localhost:8001/docs`.

Lint / format (ruff 0.8.4):
```bash
cd backend
ruff check .          # lint
ruff format --check . # format check
ruff format .         # auto-format
```

CI import smoke test (works without Postgres):
```bash
SECRET_KEY=dummy DATABASE_URL=sqlite:///./ci.db python -c "import app.main; print('ok')"
```

### Frontend (React 19 + Vite 7 + Tailwind 4)
```bash
cd frontend
npm install
npm run dev       # Vite :3001, proxies /api → :8001
npm run build     # tsc -b && vite build (also typechecks)
npm run lint      # eslint with typescript-eslint
```

### Data migration from parent NW Automation Framework
```bash
python3 scripts/migrate_from_main.py --src <OLD_DSN> --dst <NEW_DSN>
```
Copies `users`, `bng_servers`, `bng_configs`, `app_settings`.

## Architecture

Single-purpose extraction from the NW Automation Framework. **No Celery, no Redis, no WebSocket** — all BNGBlaster operations are short-lived `httpx.AsyncClient` proxies completing inside one HTTP request; SSH runs in a thread executor.

### Backend — one FastAPI process, six routers under `/api/v1`
- `auth` (`backend/app/api/v1/auth.py`) — local username/password login, user CRUD, `/auth/providers` advertises which SSO buttons to render.
- `sso` (`sso.py`) — Google + Keycloak OIDC code flow. Exchanges code → upserts user by `(provider, provider_id)` then email → issues JWT → 302s to `FRONTEND_URL/oauth-callback?token=...&user=...`.
- `bngblaster` (`bngblaster.py`, ~26 KB — the core feature surface) — CRUD for BNG servers & saved configs, proxy to controller REST API, VLAN subinterface setup over SSH. Config names are **globally unique** (409 on collision in create/update; clone auto-suffixes).
- `settings` (`settings.py`) — per-user overrides (bngblaster URL, SSH creds).
- `metrics` (`metrics.py`) — `POST /metrics/pageview` records SPA navigations; `GET /dashboard/stats` returns role-gated counters + 30-day pageview series for the Dashboard tab.
- `admin_settings` (`admin_settings.py`) — admin-only global integration config. Currently hosts the Git backup feature: save repo URL / branch / PAT (Fernet-encrypted), test GitHub connection, and push every saved BNG config to the repo as `configs/{owner}/{name}.json` plus a `.meta.json` sidecar.

Startup (`app/main.py`) calls `init_db()` and seeds a default `admin/admin123` user if none exists.

### Request flow — "Run" a config
1. `POST /bngblaster/servers/{sid}/instances/{name}/_start` with `{config_json}`.
2. Backend parses VLAN subinterfaces out of `config_json`, SSHes to the BNG host (sudo if non-root), runs `ip link add ... type vlan id ...`.
3. `PUT` config to controller at `http://{server.host}:{server.port}/api/v1/instances/{name}`, then `POST /_start`.
4. Frontend polls `/instances/{name}`, fetches `run.log` + `run_report.json` on completion.

### Data model (`backend/app/models/`)
- **users** — `auth_provider ∈ {local,google,keycloak}`, `role ∈ {admin,operator,viewer}` (hierarchy admin > operator > viewer). bcrypt hash empty for SSO users.
- **bng_servers** — controller `(host, port)` + Fernet-encrypted SSH creds (plaintext fallback when `FERNET_KEY` unset). Admin-managed only.
- **bng_configs** — JSONB `config_json`, owned by `user_id`, `name` is globally unique. Operators may edit own; admins any.
- **app_settings** — per-user URL/SSH overrides. (Note: `bng_ssh_pass` stores plaintext — inconsistency with `bng_servers.ssh_pass`; fix if the field ever becomes consumed by an SSH flow.)
- **global_settings** — single-row table for admin-configured integrations (Git backup repo URL / branch / Fernet-encrypted PAT).
- **page_views** — lightweight SPA pageview log feeding the Dashboard (path + user + timestamp; no dedupe).

### Auth
JWT HS256, 24h, `Authorization: Bearer`. All API calls go through one Axios instance (`frontend/src/services/api.ts`) with a request interceptor attaching the JWT and a 401 → logout response interceptor.

### Frontend — single-page app, five routes total
`/login`, `/oauth-callback`, `/` (BNGBlaster console: **Dashboard** · Servers · Configs · Run · Reports tabs), `/admin/users` (admin-only), `/admin/settings` (admin-only — Git backup). There is **no sidebar and no multi-tool router** — don't introduce one. The BNGBlaster page owns its own component state; only `useAuthStore` (Zustand) is global. `BNGBlasterPage.tsx` is ~200 KB and holds most of the UI — prefer editing it over creating a new top-level page.

Admin links live in the user-menu dropdown in `TopBar.tsx` (`User Management`, `Admin Settings`). The page-view tracker (`PageviewTracker` in `App.tsx`) fires `POST /metrics/pageview` on every `useLocation` path change when authenticated.

The visual config builder (`ConfigBuilder.tsx`) is driven by `backend/app/data/all_conf.yml` — the BNGBlaster schema. Changing the schema file changes the form.

### RBAC
Enforced on the backend via role checks in each router; frontend gates UI affordances through `frontend/src/utils/permissions.ts`. Full matrix in `docs/RBAC.md`.

## Conventions
- Keep it single-page — no sidebar, no additional top-level routes beyond the four above.
- No background workers; if something needs to be long-running, revisit the architecture rather than bolting on Celery/Redis.
- SSH credentials must go through the Fernet helper in `core/security.py`, not stored raw (plaintext path exists only for back-compat).
- The parent framework's DB schema is the source migration target — preserve column names in `scripts/migrate_from_main.py` when touching models.
