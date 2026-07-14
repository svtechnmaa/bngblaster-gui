"""Admin-only global settings + Git backup of all BNGBlaster configs.

Endpoints:
    GET    /admin/settings/git          — return current config (no plaintext token)
    PUT    /admin/settings/git          — save repo URL / branch / PAT
    POST   /admin/settings/git/test     — test connection (GitHub /user)
    POST   /admin/settings/git/backup   — push ALL configs to the repo
    POST   /admin/settings/git/restore  — pull configs from the repo (skip existing names)
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


async def _list_config_blobs(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    branch: str,
    token: str,
) -> tuple[dict[str, str], bool]:
    """List every blob under `configs/` in one recursive Git-tree call.

    Return ({path: blob_sha}, truncated). truncated=True means the repo has more
    files than GitHub returned in a single response (very large repos only).
    An empty/unborn branch yields ({}, False) rather than an error.
    """
    r = await client.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/git/trees/{branch}",
        headers=_gh_headers(token),
        params={"recursive": "1"},
    )
    if r.status_code in (404, 409):  # 404 branch/repo missing, 409 empty repo
        return {}, False
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"GitHub tree failed ({r.status_code}): {r.text[:200]}")
    data = r.json()
    paths = {
        item["path"]: item["sha"]
        for item in data.get("tree", [])
        if item.get("type") == "blob" and str(item.get("path", "")).startswith("configs/")
    }
    return paths, bool(data.get("truncated"))


async def _get_blob(
    client: httpx.AsyncClient,
    owner: str,
    repo: str,
    sha: str,
    token: str,
) -> str:
    """Fetch a blob's decoded UTF-8 content by its git sha (robust to odd paths)."""
    r = await client.get(
        f"{GITHUB_API}/repos/{owner}/{repo}/git/blobs/{sha}",
        headers=_gh_headers(token),
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"GitHub blob failed ({r.status_code}): {r.text[:200]}")
    meta = r.json()
    if meta.get("encoding") == "base64" and meta.get("content"):
        return base64.b64decode(meta["content"]).decode()
    return str(meta.get("content", ""))


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


@router.post("/git/backup")
async def backup_configs_to_git(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Push every saved BNGBlaster config to the configured Git repo in a SINGLE
    commit via the Git Data API (tree → commit → ref), instead of one commit per
    file. Re-running with no changes produces no commit.

    Layout: configs/{owner_username}/{safe_name}.json       — raw config_json
            configs/{owner_username}/{safe_name}.meta.json  — metadata sidecar
    """
    s = _get_or_create(db)
    owner, repo, token, branch = _require_git_config(s)
    headers = _gh_headers(token)

    configs = db.query(BNGConfig).all()
    owner_ids = list({c.user_id for c in configs})
    owner_map: dict[int, str] = {}
    if owner_ids:
        rows = db.query(User.id, User.username).filter(User.id.in_(owner_ids)).all()
        owner_map = {r.id: r.username for r in rows}

    # Stable content only (no volatile timestamps) so an unchanged backup yields
    # an identical tree — and therefore no commit.
    files: dict[str, str] = {}
    for c in configs:
        owner_username = owner_map.get(int(c.user_id), "unknown")
        folder = _safe_username(owner_username)
        slug = _safe_filename(str(c.name))
        files[f"configs/{folder}/{slug}.json"] = json.dumps(c.config_json or {}, indent=2, ensure_ascii=False) + "\n"
        files[f"configs/{folder}/{slug}.meta.json"] = (
            json.dumps(
                {
                    "name": c.name,
                    "description": c.description or "",
                    "owner": owner_username,
                    "tags": list(c.tags or []),
                    "updated_at": c.updated_at.isoformat() if c.updated_at else None,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n"
        )

    timestamp = datetime.now(UTC).isoformat()
    commit_msg = f"Backup {len(configs)} BNG configs by {current_user.username}"

    def _bad(resp: httpx.Response, what: str) -> HTTPException:
        return HTTPException(status_code=502, detail=f"GitHub {what} failed ({resp.status_code}): {resp.text[:200]}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. Resolve the branch head (base commit + tree). 404/409 = unborn branch.
        base_commit_sha: str | None = None
        base_tree_sha: str | None = None
        ref_url = f"{GITHUB_API}/repos/{owner}/{repo}/git/ref/heads/{branch}"
        r = await client.get(ref_url, headers=headers)
        if r.status_code == 200:
            base_commit_sha = r.json().get("object", {}).get("sha")
            rc = await client.get(f"{GITHUB_API}/repos/{owner}/{repo}/git/commits/{base_commit_sha}", headers=headers)
            if rc.status_code != 200:
                raise _bad(rc, "commit lookup")
            base_tree_sha = rc.json().get("tree", {}).get("sha")
        elif r.status_code not in (404, 409):
            raise _bad(r, "ref lookup")

        # 2. One tree with every file (base_tree preserves anything else in the repo).
        tree = [{"path": p, "mode": "100644", "type": "blob", "content": content} for p, content in files.items()]
        tree_body: dict[str, Any] = {"tree": tree}
        if base_tree_sha:
            tree_body["base_tree"] = base_tree_sha
        rt = await client.post(f"{GITHUB_API}/repos/{owner}/{repo}/git/trees", headers=headers, json=tree_body)
        if rt.status_code not in (200, 201):
            raise _bad(rt, "tree create")
        new_tree_sha = rt.json().get("sha")

        # 3. Nothing changed → no commit.
        if base_tree_sha and new_tree_sha == base_tree_sha:
            return {
                "repo": f"{owner}/{repo}", "branch": branch, "total": len(configs),
                "committed": False, "commit_sha": None, "message": "Already up to date", "timestamp": timestamp,
            }

        # 4. One commit.
        commit_body: dict[str, Any] = {"message": commit_msg, "tree": new_tree_sha}
        if base_commit_sha:
            commit_body["parents"] = [base_commit_sha]
        rcm = await client.post(f"{GITHUB_API}/repos/{owner}/{repo}/git/commits", headers=headers, json=commit_body)
        if rcm.status_code not in (200, 201):
            raise _bad(rcm, "commit create")
        new_commit_sha = rcm.json().get("sha")

        # 5. Point the branch at it (create the ref if the branch was unborn).
        if base_commit_sha:
            rr = await client.patch(ref_url, headers=headers, json={"sha": new_commit_sha, "force": False})
        else:
            rr = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/refs",
                headers=headers,
                json={"ref": f"refs/heads/{branch}", "sha": new_commit_sha},
            )
        if rr.status_code not in (200, 201):
            raise _bad(rr, "ref update")

    return {
        "repo": f"{owner}/{repo}", "branch": branch, "total": len(configs),
        "committed": True, "commit_sha": new_commit_sha,
        "message": f"Backed up {len(configs)} configs in 1 commit", "timestamp": timestamp,
    }


@router.post("/git/restore")
async def restore_configs_from_git(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Pull saved configs from the Git repo and create any that don't exist locally.

    For each `configs/{owner}/{name}.meta.json` sidecar we read the real config name,
    description and owner, then pair it with the sibling `{name}.json` (config_json).
    Config names are globally unique: a name that already exists in the DB is SKIPPED
    (never overwritten). Restored configs keep their original owner when that username
    still exists, otherwise they are assigned to the admin running the restore.
    """
    s = _get_or_create(db)
    owner, repo, token, branch = _require_git_config(s)

    # Global-unique names already present → skip candidates
    existing = {row[0] for row in db.query(BNGConfig.name).all()}
    # username → id, to restore original ownership where possible
    user_map = {r.username: r.id for r in db.query(User.username, User.id).all()}

    results: list[dict[str, Any]] = []
    counts = {"restored": 0, "skipped": 0, "failed": 0}

    async with httpx.AsyncClient(timeout=30.0) as client:
        paths, truncated = await _list_config_blobs(client, owner, repo, branch, token)
        meta_paths = sorted(p for p in paths if p.endswith(".meta.json"))

        for meta_path in meta_paths:
            raw_path = meta_path[: -len(".meta.json")] + ".json"
            name: str | None = None
            try:
                meta = json.loads(await _get_blob(client, owner, repo, paths[meta_path], token))
                name = (meta.get("name") or "").strip()
                if not name:
                    raise HTTPException(status_code=422, detail=f"{meta_path} has no 'name'")
                if raw_path not in paths:
                    raise HTTPException(status_code=422, detail=f"missing config file {raw_path}")

                if name in existing:
                    counts["skipped"] += 1
                    results.append({"name": name, "status": "skipped", "reason": "name already exists"})
                    continue

                config_json = json.loads(await _get_blob(client, owner, repo, paths[raw_path], token))

                owner_username = str(meta.get("owner") or "")
                assigned_to = owner_username if owner_username in user_map else current_user.username
                db.add(
                    BNGConfig(
                        user_id=user_map.get(owner_username, current_user.id),
                        name=name,
                        description=meta.get("description") or None,
                        config_json=config_json,
                    )
                )
                existing.add(name)  # guard against duplicate names within this batch
                counts["restored"] += 1
                results.append(
                    {
                        "name": name,
                        "owner": owner_username or "unknown",
                        "assigned_to": assigned_to,
                        "status": "restored",
                    }
                )
            except (HTTPException, ValueError) as exc:  # ValueError covers JSON decode errors
                counts["failed"] += 1
                detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
                results.append(
                    {
                        "name": name or meta_path,
                        "status": "failed",
                        "error": str(detail)[:200],
                    }
                )

    db.commit()

    return {
        "repo": f"{owner}/{repo}",
        "branch": branch,
        "total": len(meta_paths),
        **counts,
        "truncated": truncated,
        "details": results,
    }
