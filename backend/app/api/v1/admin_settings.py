"""Admin-only global settings + Git backup of all BNGBlaster configs.

Endpoints:
    GET    /admin/settings/git          — return current config (no plaintext token)
    PUT    /admin/settings/git          — save repo URL / branch / PAT
    POST   /admin/settings/git/test     — test connection (GitHub /user)
    POST   /admin/settings/git/backup   — push ALL configs to the repo
"""

from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import require_admin
from app.core.database import get_db
from app.core.security import decrypt_secret, encrypt_secret
from app.models.bngblaster import BNGConfig
from app.models.global_settings import GlobalSetting
from app.models.user import User

router = APIRouter(prefix="/admin/settings", tags=["Admin Settings"])

GITHUB_API = "https://api.github.com"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_or_create(db: Session) -> GlobalSetting:
    s = db.query(GlobalSetting).filter(GlobalSetting.id == 1).first()
    if not s:
        s = GlobalSetting(id=1, git_branch="main")
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def _parse_repo_url(url: str) -> tuple[str, str]:
    """Accept https://github.com/{owner}/{repo}(.git)? or git@github.com:{owner}/{repo}(.git)?
    Return (owner, repo). Raise 400 on invalid format.
    """
    if not url:
        raise HTTPException(status_code=400, detail="git_repo_url is not configured")
    url = url.strip().rstrip("/")
    m = re.match(r"^https?://github\.com/([^/]+)/([^/]+?)(\.git)?$", url)
    if not m:
        m = re.match(r"^git@github\.com:([^/]+)/([^/]+?)(\.git)?$", url)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid GitHub repo URL: {url}")
    return m.group(1), m.group(2)


def _safe_filename(name: str) -> str:
    """Sanitize a config name into a filesystem-safe slug."""
    out = re.sub(r"[^a-zA-Z0-9._-]+", "_", name.strip()).strip("._")
    return out or "config"


def _safe_username(name: str) -> str:
    """Sanitize username for use as a directory name."""
    out = re.sub(r"[^a-zA-Z0-9._-]+", "_", name.strip()).strip("._")
    return out or "unknown"


def _require_git_config(s: GlobalSetting) -> tuple[str, str, str, str]:
    if not s.git_repo_url or not s.git_token_enc:
        raise HTTPException(status_code=400, detail="Git backup is not configured. Save repo URL and PAT first.")
    owner, repo = _parse_repo_url(str(s.git_repo_url))
    token = decrypt_secret(str(s.git_token_enc))
    branch = str(s.git_branch or "main")
    return owner, repo, token, branch


def _gh_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


# ── DTOs ──────────────────────────────────────────────────────────────────────


def _settings_out(s: GlobalSetting) -> dict[str, Any]:
    return {
        "git_repo_url": s.git_repo_url or "",
        "git_branch": s.git_branch or "main",
        "git_token_set": bool(s.git_token_enc),  # never return plaintext
        "updated_at": s.updated_at,
    }


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/git")
def get_git_settings(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    return _settings_out(_get_or_create(db))


@router.put("/git")
def update_git_settings(
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    s = _get_or_create(db)

    if "git_repo_url" in data:
        url = (data["git_repo_url"] or "").strip()
        if url:
            _parse_repo_url(url)  # validate format
        s.git_repo_url = url or None
    if "git_branch" in data:
        s.git_branch = (data["git_branch"] or "main").strip() or "main"
    # Only overwrite token if client sent a non-empty string (treat "" / null as "keep existing").
    if "git_token" in data:
        token = data["git_token"]
        if token:
            s.git_token_enc = encrypt_secret(token)
        elif token == "":
            # explicit clear
            s.git_token_enc = None

    s.updated_by = current_user.id
    db.commit()
    db.refresh(s)
    return _settings_out(s)


@router.post("/git/test")
async def test_git_connection(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Verify that the configured PAT can reach GitHub and that the repo is accessible."""
    s = _get_or_create(db)
    owner, repo, token, branch = _require_git_config(s)

    async with httpx.AsyncClient(timeout=10.0) as client:
        # 1) Confirm the PAT is valid
        r = await client.get(f"{GITHUB_API}/user", headers=_gh_headers(token))
        if r.status_code != 200:
            raise HTTPException(status_code=400, detail=f"PAT invalid ({r.status_code}): {r.text[:200]}")
        gh_user = r.json().get("login")

        # 2) Confirm the repo exists and is writable
        r = await client.get(f"{GITHUB_API}/repos/{owner}/{repo}", headers=_gh_headers(token))
        if r.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Repo not accessible ({r.status_code}): {r.text[:200]}")
        repo_info = r.json()
        if not repo_info.get("permissions", {}).get("push"):
            raise HTTPException(status_code=403, detail=f"PAT has no push permission on {owner}/{repo}")

    return {
        "ok": True,
        "github_user": gh_user,
        "owner": owner,
        "repo": repo,
        "branch": branch,
        "default_branch": repo_info.get("default_branch"),
    }


async def _put_file(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    path: str,
    content_str: str,
    branch: str,
    commit_message: str,
    token: str,
) -> str:
    """PUT /repos/{owner}/{repo}/contents/{path}. Return 'created' | 'updated' | 'unchanged'."""
    headers = _gh_headers(token)
    # First try to get existing sha
    r = await client.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
        headers=headers,
        params={"ref": branch},
    )
    existing_sha: str | None = None
    existing_content: str | None = None
    if r.status_code == 200:
        meta = r.json()
        if isinstance(meta, dict):
            existing_sha = meta.get("sha")
            if meta.get("encoding") == "base64" and meta.get("content"):
                try:
                    existing_content = base64.b64decode(meta["content"]).decode()
                except Exception:
                    existing_content = None
    elif r.status_code not in (404,):
        raise HTTPException(status_code=502, detail=f"GitHub GET failed ({r.status_code}): {r.text[:200]}")

    if existing_content is not None and existing_content == content_str:
        return "unchanged"

    body: dict[str, Any] = {
        "message": commit_message,
        "content": base64.b64encode(content_str.encode()).decode(),
        "branch": branch,
    }
    if existing_sha:
        body["sha"] = existing_sha

    r = await client.put(
        f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
        headers=headers,
        json=body,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"GitHub PUT failed ({r.status_code}): {r.text[:200]}")

    return "updated" if existing_sha else "created"


@router.post("/git/backup")
async def backup_configs_to_git(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Push every saved BNGBlaster config to the configured Git repo.

    Layout: /configs/{owner_username}/{safe_name}.json       — raw config_json
            /configs/{owner_username}/{safe_name}.meta.json  — metadata sidecar
    """
    s = _get_or_create(db)
    owner, repo, token, branch = _require_git_config(s)

    configs = db.query(BNGConfig).all()
    # Build owner_id → username map
    owner_ids = list({c.user_id for c in configs})
    owner_map: dict[int, str] = {}
    if owner_ids:
        rows = db.query(User.id, User.username).filter(User.id.in_(owner_ids)).all()
        owner_map = {r.id: r.username for r in rows}

    results: list[dict[str, Any]] = []
    counts = {"created": 0, "updated": 0, "unchanged": 0, "failed": 0}
    timestamp = datetime.now(UTC).isoformat()
    commit_msg = f"Backup BNG configs ({len(configs)} items) by {current_user.username} @ {timestamp}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        for c in configs:
            owner_username = owner_map.get(int(c.user_id), "unknown")
            folder = _safe_username(owner_username)
            slug = _safe_filename(str(c.name))
            raw_path = f"configs/{folder}/{slug}.json"
            meta_path = f"configs/{folder}/{slug}.meta.json"

            raw_content = json.dumps(c.config_json or {}, indent=2, ensure_ascii=False) + "\n"
            meta_content = (
                json.dumps(
                    {
                        "name": c.name,
                        "description": c.description or "",
                        "owner": owner_username,
                        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
                        "exported_by": current_user.username,
                        "exported_at": timestamp,
                    },
                    indent=2,
                    ensure_ascii=False,
                )
                + "\n"
            )

            try:
                raw_status = await _put_file(
                    client,
                    owner,
                    repo,
                    raw_path,
                    raw_content,
                    branch,
                    commit_msg,
                    token,
                )
                meta_status = await _put_file(
                    client,
                    owner,
                    repo,
                    meta_path,
                    meta_content,
                    branch,
                    commit_msg,
                    token,
                )
                # Overall status for the config = worst of the two file statuses
                order = ["unchanged", "updated", "created"]
                overall = max((raw_status, meta_status), key=lambda x: order.index(x))
                counts[overall] += 1
                results.append({"name": c.name, "owner": owner_username, "status": overall})
            except HTTPException as exc:
                counts["failed"] += 1
                results.append(
                    {
                        "name": c.name,
                        "owner": owner_username,
                        "status": "failed",
                        "error": str(exc.detail)[:200],
                    }
                )

    return {
        "repo": f"{owner}/{repo}",
        "branch": branch,
        "total": len(configs),
        **counts,
        "details": results,
        "timestamp": timestamp,
    }
