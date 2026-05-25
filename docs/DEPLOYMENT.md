# Deployment

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Outbound network to your BNGBlaster controllers (default port 8080) and SSH (22) for VLAN setup
- A `SECRET_KEY` (32-byte hex) — `openssl rand -hex 32`
- Optional: a `FERNET_KEY` to encrypt SSH passwords at rest — `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`

## Production checklist

1. **Generate strong secrets** — `SECRET_KEY` is mandatory; `FERNET_KEY` is strongly recommended in any environment storing real SSH credentials.
2. **Change the default admin password** — log in as `admin/admin123`, then `User Management → Edit` (or recreate the user via API).
3. **Put a TLS reverse proxy in front** — Nginx or Caddy terminating HTTPS on `:443`, forwarding to `frontend:80`. The bundled Nginx serves plaintext on port 80 only.
4. **Restrict Postgres exposure** — by default `docker-compose.yml` publishes `5433:5432` for local debugging. Comment that line out in production and rely on the internal Docker network.
5. **Pin BNGBLASTER_BACKEND_URL** — only used as a default; per-user override lives in `app_settings`. Set it to your most common controller for new users' convenience.
6. **Configure SSO redirect URIs** — for both Google and Keycloak the `*_REDIRECT_URI` must exactly match what's registered in the provider. If serving via TLS, use `https://your-host/api/v1/auth/{provider}/callback`.
7. **Backups** — `bngweb_pgdata` named volume holds all state. Snapshot regularly.

## SSO

### Google OAuth2

1. Google Cloud Console → APIs & Services → Credentials → "Create OAuth client ID" (Web application).
2. **Authorized redirect URI:** `https://your-host/api/v1/auth/google/callback` (or `http://localhost:8001/...` for dev).
3. Copy `Client ID` and `Client Secret` into `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://your-host/api/v1/auth/google/callback
   ```
4. `docker compose up -d backend` — the "Sign in with Google" button appears automatically (driven by `GET /auth/providers`).

### Keycloak

1. In Keycloak admin: Realm → Clients → Create client (OpenID Connect, confidential).
2. **Valid redirect URIs:** `https://your-host/api/v1/auth/keycloak/callback`
3. Get the client secret from the *Credentials* tab.
4. Set in `.env`:
   ```
   KEYCLOAK_SERVER_URL=https://keycloak.example.com
   KEYCLOAK_REALM=your-realm
   KEYCLOAK_CLIENT_ID=bng-web
   KEYCLOAK_CLIENT_SECRET=...
   KEYCLOAK_REDIRECT_URI=https://your-host/api/v1/auth/keycloak/callback
   ```
5. **TLS verify:** `app/api/v1/sso.py` uses `verify=False` for the Keycloak HTTPX client (legacy compat). Flip to `verify=True` once your Keycloak has a properly trusted certificate chain.

## Git backup (admin)

`/admin/settings` exposes a GitHub backup of every saved BNGBlaster config. All writes go through the GitHub REST API — **no `git` binary is required in the backend container**.

1. Create a repo on GitHub (empty or pre-existing) that will hold the backups.
2. Generate a **fine-grained PAT** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: only that backup repo.
   - Repository permissions: **Contents → Read and write**, **Metadata → Read**.
3. In the web UI, log in as `admin` → **Admin Settings** → fill in:
   - **Repo URL** — `https://github.com/{owner}/{repo}` (or the `git@github.com:...` SSH-style string).
   - **Branch** — defaults to `main`.
   - **PAT** — pasted once; stored Fernet-encrypted (`FERNET_KEY` must be set in `.env` for meaningful at-rest encryption).
4. Click **Test connection** to confirm the PAT reaches the repo with push permission.
5. Click **Backup now** to push every config. Layout in the target repo:
   ```
   configs/
     {owner_username}/
       {safe_name}.json       # raw config_json, directly runnable by the BNGBlaster CLI
       {safe_name}.meta.json  # name, description, owner, timestamps
   ```
   Unchanged files are skipped (content hash via the GitHub sha). The response summarises `{created, updated, unchanged, failed}` with per-config details.

The `global_settings` single-row table holds the configuration. Revoke / rotate the PAT by clearing the field (submit an empty string) or by saving a new one (empty string = keep existing).

## Migration from NW Automation Framework

If you previously ran BNGBlaster inside the parent framework and want to preserve users / servers / configs:

```bash
# Inside the bng-web project
python3 scripts/migrate_from_main.py \
  --src postgresql+psycopg2://nw_user:nw_pass@OLD_HOST:5432/nw_automation \
  --dst postgresql+psycopg2://bng_user:bng_pass@localhost:5433/bng_web
```

The script copies four tables (`users`, `bng_servers`, `bng_configs`, `app_settings`) preserving primary keys so `user_id` foreign references on configs continue to resolve. Re-running is idempotent (uses `INSERT ... ON CONFLICT DO NOTHING`).

After migrating, **also remove** the same data from the source framework — see *Cleanup* below.

## Cleanup of the parent framework

Once the standalone app is running and validated, remove BNGBlaster code from the original framework:

1. Delete files: `backend/app/api/v1/bngblaster.py`, `backend/app/models/bngblaster.py`, `backend/app/data/all_conf.yml`, `frontend/src/components/tools/BNGBlaster/`.
2. Remove the BNGBlaster import + router registration from `backend/app/main.py`.
3. Remove the route + tool registry entry: `frontend/src/App.tsx` (`tools/bngblaster` route) and `frontend/src/config/toolRegistry.ts` (the `bngblaster` entry).
4. Remove BNG queries from `backend/app/api/v1/dashboard.py` and `analytics.py`.
5. Drop tables (after backup): `DROP TABLE bng_configs; DROP TABLE bng_servers;`. The `app_settings.bng*` columns can be dropped or left as no-ops.

## Operations

- **Logs** — `docker compose logs -f backend` / `frontend` / `postgres`
- **Restart only backend** — `docker compose up -d --build backend`
- **Reset database (destructive)** — `docker compose down -v && docker compose up -d`

## Resource sizing

This app is small. A single 1 vCPU / 1 GB RAM VM is sufficient for tens of concurrent users; scaling concerns lie almost entirely in the BNGBlaster controllers themselves, not in this proxy.
