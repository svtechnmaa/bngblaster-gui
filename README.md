# BNGBlaster Web Client

Standalone web console for managing BNGBlaster controllers, test configurations, and instance lifecycle. Extracted from the NW Automation Framework as a single-purpose tool with its own auth (local + SSO) and RBAC.

![RUNNING VIEW](images/run.jpg "Running Page")
## Stack

- **Backend** — FastAPI + SQLAlchemy + Postgres
- **Frontend** — React 19 + Vite 7 + Tailwind 4 + Zustand
- **Auth** — Local (bcrypt + JWT) **and** SSO (Google OAuth2 / Keycloak OIDC)
- **External** — `httpx` proxy to BNGBlaster controllers; `paramiko` SSH for VLAN subinterface setup on test hosts

## Quickstart

```bash
cd /opt/BNGBlaster_Web_Client
cp .env.example .env
# REQUIRED: generate SECRET_KEY
sed -i "s/change-me-to-a-32-byte-hex-string/$(openssl rand -hex 32)/" .env

docker compose up -d --build
```

| URL | Purpose |
|---|---|
| http://localhost:3001 | Web UI |
| http://localhost:8001/docs | Swagger / OpenAPI |
| http://localhost:8001/health | Health check |
| localhost:5433 | Postgres (bng_user / bng_pass) |

**Default login:** `admin` / `admin123` — change immediately via `User Management → Edit`.

## Single-page UI

This is a **one-page application**. There is no sidebar, no multi-tool router. Routes:

- `/login` — local + SSO sign-in
- `/oauth-callback` — SSO redirect target
- `/` — BNGBlaster console (Dashboard · Servers · Configs · Run · Reports tabs)
- `/admin/users` — admin-only user management
- `/admin/settings` — admin-only system settings (Git backup of all saved configs)

## RBAC

Three roles, hierarchy `admin > operator > viewer`. See [docs/RBAC.md](docs/RBAC.md) for the full matrix.

| Action | admin | operator | viewer |
|---|:-:|:-:|:-:|
| Manage BNG servers | ✅ | ❌ | ❌ |
| Manage users | ✅ | ❌ | ❌ |
| Create configs | ✅ | ✅ | ❌ |
| Edit / delete own configs | ✅ | ✅ | ❌ |
| Edit / delete others' configs | ✅ | ❌ | ❌ |
| Clone any config | ✅ | ✅ | ✅ |
| Download / export / import configs | ✅ | ✅ | ✅ (download only) |
| Start / stop / kill instances | ✅ (any) | ✅ (own) | ❌ |
| View results | ✅ | ✅ | ✅ |
| Admin settings / Git backup | ✅ | ❌ | ❌ |
| View dashboard | ✅ (full) | ✅ (full) | ✅ (own-only) |

## SSO setup

Both providers are optional. Setting the env vars enables the corresponding sign-in button on the login page. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#sso) for callback URL configuration.

## Migrating from NW Automation Framework

If you are extracting from the original framework and want to preserve existing users, BNG servers, and saved configs:

```bash
# Connects to the OLD postgres + the NEW postgres, copies users/bng_servers/bng_configs/app_settings
python3 scripts/migrate_from_main.py \
  --src postgresql+psycopg2://nw_user:nw_pass@OLD_HOST:5432/nw_automation \
  --dst postgresql+psycopg2://bng_user:bng_pass@localhost:5433/bng_web
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#migration) for details.

## Local development

```bash
# Backend (Postgres must be running)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SECRET_KEY=$(openssl rand -hex 32) DATABASE_URL=postgresql+psycopg2://bng_user:bng_pass@localhost:5433/bng_web \
  uvicorn app.main:app --reload --port 8001

# Frontend
cd frontend
npm install
npm run dev    # Vite on :3001, proxies /api → :8001
```

## Repository layout

```
backend/         FastAPI app
  app/
    api/v1/      auth.py · sso.py · bngblaster.py · settings.py · metrics.py · admin_settings.py
    core/        config.py · database.py · security.py (Fernet helpers)
    models/      user.py · bngblaster.py · settings.py · metrics.py · global_settings.py
    schemas/     auth.py
    data/        all_conf.yml (BNGBlaster schema for visual builder)
frontend/        React SPA
  src/
    components/          Login · OAuthCallback · TopBar · BNGBlasterPage · ConfigBuilder
    components/admin/    UsersPage · SettingsPage (git backup)
    components/dashboard/ DashboardTab (recharts)
    components/topology/ TopologyView (SVG)
    services/            api.ts (axios + JWT)
    store/               useAuthStore.ts
    utils/               permissions.ts · topologyParser.ts · metrics.ts
    styles/              index.css (design tokens)
docs/            ARCHITECTURE · API · RBAC · DEPLOYMENT
scripts/         migrate_from_main.py
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — request flow, components, external integration
- [API reference](docs/API.md) — every endpoint
- [RBAC matrix](docs/RBAC.md) — role × action permissions
- [Deployment guide](docs/DEPLOYMENT.md) — production hardening, SSO, migration
- [Admin guide](docs/ADMIN_GUIDE.md) — setup, curl cheatsheet, troubleshooting
- [Upgrade plan](docs/UPGRADE_PLAN.md) — improvement roadmap (security, stability, DX)
