# RBAC

## Roles

| Role | Hierarchy | Created by |
|---|---|---|
| `admin` | top — full access | seeded `admin/admin123` on first start; admins create more via `/admin/users` |
| `operator` | mid — own resources + run | admins can promote; SSO new users default here |
| `viewer` | low — read-only | admins assign |

## Permission matrix

| Action | Endpoint(s) | admin | operator | viewer |
|---|---|:-:|:-:|:-:|
| **Auth** | | | | |
| Sign in (local + SSO) | `/auth/login`, `/auth/{provider}/login` | ✅ | ✅ | ✅ |
| Get own profile | `/auth/me` | ✅ | ✅ | ✅ |
| **User management** | | | | |
| List / create / edit / delete users | `/auth/users*` | ✅ | ❌ | ❌ |
| **BNG servers** | | | | |
| List servers | `GET /bngblaster/servers` | ✅ | ✅ | ✅ |
| Create / edit / delete server | `POST/PUT/DELETE /bngblaster/servers` | ✅ | ❌ | ❌ |
| List / cleanup VLAN interfaces | `/bngblaster/servers/{id}/{ssh-list-vlan-interfaces,cleanup-interfaces}` | ✅ | ✅ | ✅ |
| **BNG configs** | | | | |
| List configs | `GET /bngblaster/configs` (own first) | ✅ | ✅ | ✅ |
| Create config | `POST /bngblaster/configs` | ✅ | ✅ | ❌ |
| Edit own config | `PUT /bngblaster/configs/{id}` | ✅ | ✅ | ❌ |
| Edit others' config | same | ✅ | ❌ | ❌ |
| Delete own config | `DELETE /bngblaster/configs/{id}` | ✅ | ✅ | ❌ |
| Delete others' config | same | ✅ | ❌ | ❌ |
| Clone any config | `POST /bngblaster/configs/{id}/clone` | ✅ | ✅ | ✅ |
| Download / export configs (browser) | client-side only (reads `GET /bngblaster/configs`) | ✅ | ✅ | ✅ |
| Import configs (file upload) | `POST /bngblaster/configs` (per-entry) | ✅ | ✅ | ❌ |
| **Instance lifecycle** | | | | |
| View instance status / logs / report | `GET /bngblaster/servers/{sid}/instances/*` | ✅ | ✅ | ✅ |
| Start / push config + start (own) | `POST .../start`, `.../_start` | ✅ | ✅ (own config) | ❌ |
| Start / push config + start (others') | same | ✅ | ❌ | ❌ |
| Stop / kill / send command | `POST .../stop`, `.../kill`, `.../command` | ✅ | ✅ | ❌ |
| Delete instance | `DELETE .../instances/{name}` | ✅ | ✅ | ❌ |
| **Settings** | | | | |
| Read / write own per-user settings | `GET/PUT /settings` | ✅ | ✅ | ✅ |
| **Dashboard & metrics** | | | | |
| Record own pageview | `POST /metrics/pageview` | ✅ | ✅ | ✅ |
| View dashboard (own-only slice) | `GET /dashboard/stats` | ✅ | ✅ | ✅ |
| View dashboard (user breakdown, top owners, active users) | same | ✅ | ✅ | ❌ (hidden) |
| **Admin settings (Git backup)** | | | | |
| Read / update Git backup config | `GET/PUT /admin/settings/git` | ✅ | ❌ | ❌ |
| Test Git connection | `POST /admin/settings/git/test` | ✅ | ❌ | ❌ |
| Trigger Git backup (all configs) | `POST /admin/settings/git/backup` | ✅ | ❌ | ❌ |

## Implementation

- **Backend** — `app/api/deps.py` provides `get_current_user`, `require_admin`, `require_operator`. Ownership checks for configs are inline in `bngblaster.py` (`c.user_id != current_user.id and current_user.role != "admin"`). Admin-only routers (`admin_settings.py`) inject `require_admin` at the top of every endpoint.
- **Frontend** — `src/utils/permissions.ts` mirrors the matrix as `can.*` helpers. Components consume them to hide/disable buttons; the backend remains the single source of truth for enforcement.
- **Default admin** — `admin/admin123` is seeded on first startup (see `_seed_default_admin` in `backend/app/main.py`). It cannot be deleted or have its role changed (UI + backend guard). **Change the password immediately.**

## SSO and roles

New users created via Google or Keycloak SSO get `role=operator`. An admin can later promote them to `admin` or demote to `viewer` via `/admin/users`. A user's auth provider is shown in the user table.
