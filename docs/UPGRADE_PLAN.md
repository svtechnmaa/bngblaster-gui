# Upgrade Plan — BNGBlaster Web Client

Comprehensive improvement roadmap covering security, stability, maintainability, and developer experience across the full stack.

Last updated: 2026-04-28

---

## Critical — fix ASAP

### 1. Race condition in `_get_or_create` (settings + SSO)

**Files:** `backend/app/api/v1/settings.py:14-21`, `backend/app/api/v1/sso.py:44-95`

Check-then-insert without transaction isolation. When a user logs in for the first time, the SPA fires parallel requests (`GET /settings`, `GET /dashboard/stats`, etc.) — multiple transactions see "no row" and all try to INSERT → `UniqueViolation` on `app_settings_pkey`. Same pattern exists in `_upsert_sso_user` for concurrent OAuth logins.

**Evidence:** 10 `UniqueViolation` errors in backend logs for `user_id=4` (2026-04-16).

**Fix:** Catch `IntegrityError`, rollback, and re-query:

```python
from sqlalchemy.exc import IntegrityError

def _get_or_create(user_id: int, db: Session) -> AppSetting:
    setting = db.query(AppSetting).filter(AppSetting.user_id == user_id).first()
    if setting:
        return setting
    try:
        setting = AppSetting(user_id=user_id)
        db.add(setting)
        db.commit()
        db.refresh(setting)
        return setting
    except IntegrityError:
        db.rollback()
        return db.query(AppSetting).filter(AppSetting.user_id == user_id).first()
```

Apply the same pattern to `sso.py:_upsert_sso_user` and `admin_settings.py:_get_or_create`.

---

### 2. Bare `except Exception` silently falls back to plaintext

**File:** `backend/app/core/security.py:67, 83`

`encrypt_secret` and `decrypt_secret` catch all exceptions and return the value as-is (plaintext). If `FERNET_KEY` is misconfigured or rotated, SSH passwords and the Git backup PAT are silently stored/returned in plaintext — no log, no warning.

**Fix:**
- Catch `cryptography.fernet.InvalidToken` specifically.
- Log a warning on failure (`logger.warning("Fernet decryption failed for ...")`) so admins notice in logs.
- Consider failing hard on encrypt (raise) — plaintext write is worse than a visible error.

---

### 3. Keycloak `verify=False` — disabled TLS verification

**File:** `backend/app/api/v1/sso.py:201`

```python
async with httpx.AsyncClient(verify=False) as client:
```

MITM risk on the Keycloak token exchange. The comment says "set verify=True in prod" but there is no mechanism to do so.

**Fix:** Add `KEYCLOAK_VERIFY_SSL` env var (default `True`), use it in the httpx client constructor.

---

### 4. Shell injection risk in VLAN setup

**File:** `backend/app/api/v1/bngblaster.py:106-115`

Interface names from `config_json` are interpolated into a bash script sent over SSH:

```python
lines.append(f"ip link add link {parent} name {iface} type vlan id {vlan_id}...")
```

If a config contains a crafted interface name like `eth0; rm -rf /`, it gets executed.

**Fix:** Validate interface names with regex `^[a-zA-Z0-9.:_-]+$` and VLAN ID as integer 1-4094 before building the script. Reject configs that fail validation.

---

### 5. Admin seed logs plaintext password

**File:** `backend/app/main.py:62`

```python
log.info("Seeded default admin user (username=admin, password=admin123)")
```

Credentials visible in `docker compose logs backend`.

**Fix:** Remove the password from the log message: `log.info("Seeded default admin user (username=admin)")`.

---

## High — operational quality

### 6. DB connection pool unbounded

**File:** `backend/app/core/database.py:12-17`

`create_engine()` called without pool limits. Under load, the pool grows unbounded → Postgres `max_connections` exhaustion.

**Fix:**

```python
engine = create_engine(
    settings.DATABASE_URL,
    pool_size=20,
    max_overflow=10,
    pool_recycle=3600,
    pool_pre_ping=True,
)
```

---

### 7. Nginx missing gzip compression

**File:** `frontend/nginx.conf`

JSON responses (configs list ~10KB, reports ~12KB) and JS/CSS assets served uncompressed.

**Fix:** Add inside the `server {}` block:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 512;
gzip_types text/plain text/css application/json application/javascript text/xml;
```

---

### 8. Backend container missing Docker healthcheck

**File:** `docker-compose.yml`

Postgres has a healthcheck but backend does not. Orchestrators (Compose, Swarm, K8s) cannot detect when the backend is unresponsive.

**Fix:**

```yaml
backend:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
    interval: 10s
    timeout: 3s
    retries: 3
```

(Requires `curl` in the backend image, or use `python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"` as alternative.)

---

### 9. Frontend: no React Error Boundary

**File:** `frontend/src/App.tsx`

A single component crash (e.g. undefined property access in ConfigBuilder) takes down the entire SPA — user sees white screen with no recovery option.

**Fix:** Create `<ErrorBoundary>` component wrapping the main `<Routes>`. Display a "Something went wrong — reload" fallback UI instead of a blank page.

---

### 10. Frontend: silent API error swallowing

**Files:** `frontend/src/components/BNGBlasterPage.tsx:273`, `Login.tsx:20`

```typescript
.catch(() => { })  // user has no idea why servers aren't loading
```

**Fix:** Replace empty catch with a toast/notification: `catch(err => toast.error("Failed to load servers"))`. Consider a global Axios response interceptor that shows a toast for any non-401 error.

---

### 11. No rate limiting on `/auth/login`

**Files:** Backend has no rate-limit middleware.

Brute-force login attempts are not throttled.

**Fix (Nginx-level, simplest):**

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/s;

location /api/v1/auth/login {
    limit_req zone=login burst=10 nodelay;
    proxy_pass $backend;
    # ... existing proxy headers ...
}
```

Or backend-level: add `slowapi` middleware scoped to auth endpoints.

---

### 12. Missing DB unique constraint on `bng_configs.name`

**File:** `backend/app/models/bngblaster.py:27`

Application code enforces uniqueness (409 Conflict), but the database has no `UNIQUE` constraint. A direct SQL insert or migration script can bypass the check.

**Fix:** Add `unique=True` to the `name` column:

```python
name = Column(String(255), nullable=False, unique=True)
```

Note: this will make the error a raw `IntegrityError` instead of the current friendly 409. Wrap the create/update endpoints to catch `IntegrityError` on `name` and return 409.

---

### 13. Paramiko `AutoAddPolicy()` accepts any SSH host key

**File:** `backend/app/api/v1/bngblaster.py:126`

```python
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
```

MITM risk on SSH connections to BNG servers.

**Fix:** Use `WarningPolicy()` + log, or maintain a `known_hosts` file (could be a new field on `bng_servers` storing the expected host key fingerprint).

---

## Medium — maintainability and DX

### 14. BNGBlasterPage.tsx is ~2800 lines (mega-component)

**File:** `frontend/src/components/BNGBlasterPage.tsx`

145+ state variables, 5 tabs mixed in one file, 660+ lines of inline sub-components. Hard to test, hard to add features without regression.

**Fix:** Extract each tab into its own component file:

```
components/
  tabs/
    ServersTab.tsx
    ConfigsTab.tsx
    RunTab.tsx
    ReportsTab.tsx
```

Extract shared logic into custom hooks: `useInstances()`, `useVlanSetup()`, `useMonitoring()`.

---

### 15. No test suite

**Files:** No `tests/` directory in backend or frontend.

**Fix:**
- Backend: add `pytest` + `httpx` (TestClient) fixtures for auth, config CRUD, unique name enforcement, admin settings. Target 50% coverage on critical paths.
- Frontend: add `vitest` + React Testing Library. Start with Login, auth store, permissions util.

---

### 16. Hardcoded timeout values scattered across codebase

**File:** `backend/app/api/v1/bngblaster.py` — `timeout=30.0`, `timeout=10.0`, `timeout=15` in multiple locations.

**Fix:** Centralize in `core/config.py`:

```python
SSH_TIMEOUT: int = 15
HTTP_PROXY_TIMEOUT: int = 30
GITHUB_API_TIMEOUT: int = 10
```

Reference from routers via `settings.SSH_TIMEOUT`.

---

### 17. No pagination on config/server list endpoints

**File:** `backend/app/api/v1/bngblaster.py:356-371`

`GET /bngblaster/configs` returns all rows. At 10,000+ configs this becomes a multi-MB JSON response.

**Fix:** Add `?limit=50&offset=0` query params with a `max_limit=200` cap. Return `{items: [...], total: int}` envelope.

---

### 18. No audit logging for admin actions

**Files:** Auth endpoints (`auth.py`), user CRUD, server CRUD, admin settings.

User creation, deletion, role changes, Git backup triggers — none are logged beyond the default Uvicorn access log.

**Fix:** Create an `audit_log` table: `(id, actor_id, action, target_type, target_id, detail_json, created_at)`. Log all mutations. Expose `GET /admin/audit` for admin review.

---

### 19. CORS configuration overly permissive

**File:** `backend/app/main.py:25-31`

```python
allow_methods=["*"],
allow_headers=["*"],
```

**Fix:** Specify explicitly: `allow_methods=["GET", "POST", "PUT", "DELETE"]`, `allow_headers=["Authorization", "Content-Type"]`.

(Note: with the Nginx same-origin setup, CORS is rarely triggered in practice. This matters mainly if someone bypasses Nginx and hits backend directly.)

---

### 20. Missing security headers in Nginx

**File:** `frontend/nginx.conf`

No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`.

**Fix:** Add to the `server {}` block:

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "same-origin" always;
# add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval';" always;
# add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;  # only with HTTPS
```

---

## Low — nice-to-have

### 21. No token revocation / short-lived tokens

Logout only clears client-side state. A stolen JWT is valid for 24 hours.

**Fix (lightweight):** Reduce token TTL to 15 minutes, add a `/auth/refresh` endpoint that issues new tokens (checking user still active + not revoked). Frontend Axios interceptor auto-refreshes on 401.

---

### 22. Frontend: no retry on transient GET failures

**File:** `frontend/src/services/api.ts`

Network glitch → immediate failure. No retry.

**Fix:** Add `axios-retry` with exponential backoff (max 3 attempts) for GET/HEAD methods only.

---

### 23. Missing loading skeletons / spinners

**Files:** `ConfigBuilder.tsx`, `DashboardTab.tsx`, `BNGBlasterPage.tsx`

Data loads → blank area → content jumps in. Poor UX on slow connections.

**Fix:** Add skeleton placeholders or spinner overlays while API calls are in-flight.

---

### 24. Metrics pageview not rate-limited

**File:** `backend/app/api/v1/metrics.py:18-28`

Any authenticated user can spam `POST /metrics/pageview` → unbounded DB growth.

**Fix:** Deduplicate: skip insert if same `(user_id, path)` exists within the last 60 seconds.

---

### 25. SSO full_name not refreshed on subsequent logins

**File:** `backend/app/api/v1/sso.py:89`

```python
if full_name and not user.full_name:
    user.full_name = full_name
```

Only sets if previously empty. User changes name in Google → app keeps the old one.

**Fix:** Always update: `user.full_name = full_name or user.full_name`.

---

### 26. TypeScript strict mode not enabled

**File:** `frontend/tsconfig.json`

`strict: true` and `noImplicitAny: true` are not set. Allows type-unsafe code to slip through.

**Fix:** Enable incrementally. Start with `noImplicitAny`, then full `strict`.

---

## Suggested timeline

| Sprint | Focus | Items | Effort estimate |
|---|---|---|---|
| **Week 1** | Security fixes | #1, #2, #3, #4, #5, #11, #13 | ~2-3 days |
| **Week 2** | Stability | #6, #7, #8, #9, #10, #12 | ~2 days |
| **Week 3** | Maintainability | #14, #15, #16, #17 | ~3-4 days |
| **Week 4** | Hardening | #18, #19, #20 | ~1-2 days |
| **Backlog** | Nice-to-have | #21-#26 | Pick as time allows |

---

## Reference

- [Architecture](ARCHITECTURE.md) — component overview, request flows
- [API reference](API.md) — endpoint documentation
- [RBAC matrix](RBAC.md) — role permissions
- [Admin guide](ADMIN_GUIDE.md) — setup, troubleshooting, curl cheatsheet
- [Deployment](DEPLOYMENT.md) — production hardening, SSO, migration
