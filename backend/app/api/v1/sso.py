"""
SSO (Single Sign-On) endpoints — Google OAuth2 and Keycloak OIDC.

Flow:
  1. Frontend calls GET /auth/{provider}/login → gets {auth_url}
  2. Frontend redirects browser to auth_url
  3. Provider redirects back to GET /auth/{provider}/callback?code=...
  4. Backend exchanges code for user info, upserts User, issues JWT
  5. Backend redirects to {FRONTEND_URL}/oauth-callback?token=JWT&...
"""

import re
import urllib.parse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.auth import UserResponse

router = APIRouter(prefix="/auth", tags=["SSO"])
_s = get_settings()


# ── Helpers ───────────────────────────────────────────────────────────────────


def _gen_username(db: Session, email: str) -> str:
    """Derive a unique username from an email address."""
    base = re.sub(r"[^a-z0-9_]", "_", email.split("@")[0].lower())[:30]
    candidate = base
    i = 1
    while db.query(User).filter(User.username == candidate).first():
        candidate = f"{base}_{i}"
        i += 1
    return candidate


def _upsert_sso_user(
    db: Session,
    provider: str,
    provider_id: str,
    email: str,
    full_name: str,
    avatar_url: str,
) -> User:
    """Find or create a User for an SSO login.

    Lookup priority:
    1. (auth_provider, provider_id) — same provider, same account
    2. email — existing local/other-provider account with same email
    3. Create new user with role=operator (admin can change afterwards)
    """
    user = (
        db.query(User)
        .filter(
            User.auth_provider == provider,
            User.provider_id == provider_id,
        )
        .first()
    )

    if not user and email:
        user = db.query(User).filter(User.email == email).first()

    if not user:
        user = User(
            username=_gen_username(db, email or provider_id),
            email=email or None,
            full_name=full_name or email,
            auth_provider=provider,
            provider_id=provider_id,
            avatar_url=avatar_url or None,
            password_hash="",  # SSO users have no local password
            role="operator",
            is_active=1,
        )
        db.add(user)
    else:
        # Update mutable fields on each login
        user.auth_provider = provider
        user.provider_id = provider_id
        if avatar_url:
            user.avatar_url = avatar_url
        if full_name and not user.full_name:
            user.full_name = full_name

    db.commit()
    db.refresh(user)
    return user


def _issue_redirect(user: User) -> RedirectResponse:
    """Issue a JWT and redirect the browser to the SPA callback route."""
    token = create_access_token(data={"sub": user.username, "role": user.role})
    user_data = UserResponse.model_validate(user).model_dump()
    # Encode user info as query param so the SPA can bootstrap auth state
    import json
    params = urllib.parse.urlencode(
        {
            "token": token,
            "user": json.dumps(user_data, default=str),
        }
    )
    return RedirectResponse(url=f"{_s.FRONTEND_URL}/oauth-callback?{params}")


# ── Google OAuth2 ─────────────────────────────────────────────────────────────

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


@router.get("/google/login")
def google_login():
    """Return the Google authorization URL."""
    if not _s.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth2 not configured")
    params = {
        "client_id": _s.GOOGLE_CLIENT_ID,
        "redirect_uri": _s.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
    }
    return {"auth_url": f"{_GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"}


@router.get("/google/callback")
async def google_callback(code: str, db: Session = Depends(get_db)):
    """Handle Google OAuth2 callback."""
    if not _s.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth2 not configured")
    async with httpx.AsyncClient() as client:
        # Exchange authorization code for tokens
        token_resp = await client.post(
            _GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": _s.GOOGLE_CLIENT_ID,
                "client_secret": _s.GOOGLE_CLIENT_SECRET,
                "redirect_uri": _s.GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Google token exchange failed")
        access_token = token_resp.json().get("access_token")

        # Fetch user profile
        info_resp = await client.get(
            _GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if info_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to fetch Google user info")
        info = info_resp.json()

    user = _upsert_sso_user(
        db,
        provider="google",
        provider_id=info["sub"],
        email=info.get("email", ""),
        full_name=info.get("name", ""),
        avatar_url=info.get("picture", ""),
    )
    return _issue_redirect(user)


# ── Keycloak OIDC ─────────────────────────────────────────────────────────────


def _kc_base() -> str:
    return f"{_s.KEYCLOAK_SERVER_URL}/realms/{_s.KEYCLOAK_REALM}/protocol/openid-connect"


@router.get("/keycloak/login")
def keycloak_login():
    """Return the Keycloak authorization URL."""
    if not (_s.KEYCLOAK_SERVER_URL and _s.KEYCLOAK_REALM and _s.KEYCLOAK_CLIENT_ID):
        raise HTTPException(status_code=501, detail="Keycloak OIDC not configured")
    params = {
        "client_id": _s.KEYCLOAK_CLIENT_ID,
        "redirect_uri": _s.KEYCLOAK_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
    }
    return {"auth_url": f"{_kc_base()}/auth?{urllib.parse.urlencode(params)}"}


@router.get("/keycloak/callback")
async def keycloak_callback(code: str, db: Session = Depends(get_db)):
    """Handle Keycloak OIDC callback."""
    if not (_s.KEYCLOAK_SERVER_URL and _s.KEYCLOAK_REALM and _s.KEYCLOAK_CLIENT_ID):
        raise HTTPException(status_code=501, detail="Keycloak OIDC not configured")
    async with httpx.AsyncClient(verify=False) as client:  # set verify=True in prod with proper CA
        token_resp = await client.post(
            f"{_kc_base()}/token",
            data={
                "code": code,
                "client_id": _s.KEYCLOAK_CLIENT_ID,
                "client_secret": _s.KEYCLOAK_CLIENT_SECRET,
                "redirect_uri": _s.KEYCLOAK_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Keycloak token exchange failed")
        access_token = token_resp.json().get("access_token")

        info_resp = await client.get(
            f"{_kc_base()}/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if info_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to fetch Keycloak user info")
        info = info_resp.json()

    user = _upsert_sso_user(
        db,
        provider="keycloak",
        provider_id=info.get("sub", ""),
        email=info.get("email", ""),
        full_name=info.get("name", info.get("preferred_username", "")),
        avatar_url="",
    )
    return _issue_redirect(user)
