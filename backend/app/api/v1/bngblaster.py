"""BNGBlaster API — server management, config CRUD, and test control proxy."""

import asyncio
import pathlib
from typing import Any

import httpx
import paramiko
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_admin, require_operator
from app.core.database import get_db
from app.core.security import decrypt_secret, encrypt_secret
from app.models.bngblaster import BNGConfig, BNGServer
from app.models.user import User

router = APIRouter(prefix="/bngblaster", tags=["BNGBlaster"])

_SCHEMA_PATH = pathlib.Path(__file__).parent.parent.parent / "data" / "all_conf.yml"


# ── Schema endpoint ───────────────────────────────────────────────────────────


@router.get("/schema")
def get_schema():
    """Return parsed all_conf.yml as JSON for the visual config builder UI."""
    import os

    import yaml

    if not os.path.exists(_SCHEMA_PATH):
        raise HTTPException(status_code=404, detail="Schema file not found")
    try:
        with open(_SCHEMA_PATH) as f:
            return yaml.safe_load(f)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to parse schema: {exc}") from exc


# ── Internal helpers ──────────────────────────────────────────────────────────


def _bng_url(server: BNGServer) -> str:
    return f"http://{server.host}:{server.port}"


async def _proxy(
    method: str,
    base_url: str,
    path: str,
    json_data: Any = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    """Forward one request to a BNGBlaster server and return (status_code, body)."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, f"{base_url}{path}", json=json_data)
            ct = resp.headers.get("content-type", "")
            body = resp.json() if "application/json" in ct else resp.text
            return resp.status_code, body
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=503, detail=f"Cannot reach BNGBlaster at {base_url}") from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="BNGBlaster request timed out") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Proxy error: {exc}") from exc


def _require_server(server_id: int, db: Session) -> BNGServer:
    s = db.query(BNGServer).filter(BNGServer.id == server_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="BNG server not found")
    return s


def _server_out(s: BNGServer) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "host": s.host,
        "port": s.port,
        "ssh_user": s.ssh_user,
        "ssh_pass": s.ssh_pass,
        "created_at": s.created_at,
    }


def _extract_vlan_interfaces(obj: Any, result: set | None = None) -> set[str]:
    """Recursively find all "interface" field values that contain "." (VLAN subinterfaces)."""
    if result is None:
        result = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "interface" and isinstance(v, str) and "." in v:
                result.add(v)
            else:
                _extract_vlan_interfaces(v, result)
    elif isinstance(obj, list):
        for item in obj:
            _extract_vlan_interfaces(item, result)
    return result


def _build_vlan_script(interfaces: set[str]) -> str:
    """Build a shell script (no sudo prefix) to create VLAN subinterfaces."""
    lines = ["modprobe 8021q"]
    for iface in sorted(interfaces):
        parts = iface.rsplit(".", 1)
        if len(parts) == 2:
            parent, vlan_id = parts
            lines.append(f"ip link add link {parent} name {iface} type vlan id {vlan_id} 2>/dev/null || true")
            lines.append(f"ip link set dev {iface} up")
    return "\n".join(lines)


async def _ssh_setup_vlans(host: str, ssh_user: str, ssh_pass: str, script: str) -> dict:
    """SSH into host and run a bash script, using sudo when the user is not root.

    Returns { stdout, stderr, exit_code, success }.
    """

    def _run():
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(host, username=ssh_user, password=ssh_pass, timeout=15)

        # Root can run bash directly; non-root users need sudo -S to supply password via stdin
        if ssh_user == "root":
            cmd = "bash"
            stdin_data = script + "\n"
        else:
            cmd = "sudo -S -p '' bash"
            stdin_data = ssh_pass + "\n" + script + "\n"

        # exec_command returns proper file-like objects — more reliable than raw channel.sendall
        stdin_fh, stdout_fh, stderr_fh = client.exec_command(cmd, timeout=30)
        stdin_fh.write(stdin_data)
        stdin_fh.flush()
        stdin_fh.channel.shutdown_write()

        out = stdout_fh.read().decode(errors="replace").strip()
        err = stderr_fh.read().decode(errors="replace").strip()
        exit_code = stdout_fh.channel.recv_exit_status()
        client.close()

        # Filter sudo password-prompt lines from stderr
        err_clean = "\n".join(
            line for line in err.splitlines() if not line.strip().startswith("[sudo]") and line.strip() != ""
        )
        return {
            "stdout": out,
            "stderr": err_clean.strip(),
            "exit_code": exit_code,
            "success": exit_code == 0,
        }

    return await asyncio.get_event_loop().run_in_executor(None, _run)


def _config_out(c: BNGConfig, current_user_id: int = 0, owner_username: str = "") -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "config_json": c.config_json,
        "user_id": c.user_id,
        "owner_username": owner_username,
        "is_owner": c.user_id == current_user_id,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


# ── BNG Server management ─────────────────────────────────────────────────────


@router.get("/servers")
def list_servers(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return all BNG servers (visible to all authenticated users)."""
    servers = db.query(BNGServer).order_by(BNGServer.created_at.desc()).all()
    return [_server_out(s) for s in servers]


@router.post("/servers", status_code=201)
def create_server(
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    s = BNGServer(
        user_id=current_user.id,
        name=data.get("name") or data.get("host", "BNG Server"),
        host=data["host"],
        port=int(data.get("port", 8001)),
        ssh_user=data.get("ssh_user") or None,
        ssh_pass=encrypt_secret(data.get("ssh_pass") or "") or None,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _server_out(s)


@router.put("/servers/{server_id}")
def update_server(
    server_id: int,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    s = _require_server(server_id, db)
    if "name" in data:
        s.name = data["name"] or s.host
    if "host" in data:
        s.host = data["host"]
    if "port" in data:
        s.port = int(data["port"] or 8001)
    if "ssh_user" in data:
        s.ssh_user = data["ssh_user"] or None
    if "ssh_pass" in data:
        s.ssh_pass = encrypt_secret(data["ssh_pass"] or "") or None
    db.commit()
    db.refresh(s)
    return _server_out(s)


@router.delete("/servers/{server_id}")
def delete_server(
    server_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    s = _require_server(server_id, db)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.post("/servers/{server_id}/ssh-list-vlan-interfaces")
async def ssh_list_vlan_interfaces(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSH into the server and list all VLAN subinterfaces currently present."""
    server = _require_server(server_id, db)
    if not server.ssh_user or not server.ssh_pass:
        raise HTTPException(status_code=400, detail="SSH credentials not configured for this server")

    def _run():
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            server.host, username=server.ssh_user, password=decrypt_secret(server.ssh_pass or ""), timeout=10
        )
        # List all VLAN interfaces (they show up with type vlan)
        _, stdout, stderr = client.exec_command(
            "ip -o link show type vlan 2>/dev/null | awk '{print $2}' | sed 's/://'", timeout=10
        )
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        client.close()
        # "ip -o link show type vlan" outputs names like "ens16.300@ens16" — strip @parent suffix
        ifaces = [line.strip().split("@")[0] for line in out.splitlines() if line.strip()]
        return ifaces, err

    try:
        ifaces, err = await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH error: {e}") from e

    return {"interfaces": sorted(ifaces)}


@router.post("/servers/{server_id}/cleanup-interfaces")
async def cleanup_vlan_interfaces(
    server_id: int,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSH into the server and delete specified VLAN subinterfaces."""
    server = _require_server(server_id, db)
    if not server.ssh_user or not server.ssh_pass:
        raise HTTPException(status_code=400, detail="SSH credentials not configured for this server")

    interfaces: list[str] = data.get("interfaces", [])
    if not interfaces:
        raise HTTPException(status_code=400, detail="No interfaces specified")

    lines = ["set +e"]  # try every interface even if one fails
    for iface in interfaces:
        # Parse parent and vlan id from e.g. "ens3.300"
        if "." in iface:
            parent, vlan_id = iface.rsplit(".", 1)
        else:
            parent, vlan_id = iface, ""
        # Bring down first (ignore if already down)
        lines.append(f"ip link set dev {iface} down 2>/dev/null")
        if vlan_id:
            lines.append(
                f"ip link delete link {parent} name {iface} type vlan id {vlan_id}"
                f" && echo 'DELETED: {iface}'"
                f" || echo 'FAILED: {iface}'"
            )
        else:
            lines.append(f"ip link delete {iface} && echo 'DELETED: {iface}' || echo 'FAILED: {iface}'")
    script = "\n".join(lines)

    try:
        result = await _ssh_setup_vlans(server.host, server.ssh_user, decrypt_secret(server.ssh_pass or ""), script)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH error: {e}") from e

    stdout = result["stdout"]
    deleted = [line.replace("DELETED: ", "").strip() for line in stdout.splitlines() if line.startswith("DELETED:")]
    failed = [line.replace("FAILED: ", "").strip() for line in stdout.splitlines() if line.startswith("FAILED:")]

    return {
        "success": len(deleted) > 0 and len(failed) == 0,
        "stdout": stdout,
        "stderr": result["stderr"],
        "exit_code": result["exit_code"],
        "cleaned": deleted,
        "failed": failed,
    }


# ── Test config management ────────────────────────────────────────────────────


def _name_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    """Return True if another config already uses this name (globally unique)."""
    q = db.query(BNGConfig).filter(BNGConfig.name == name)
    if exclude_id is not None:
        q = q.filter(BNGConfig.id != exclude_id)
    return db.query(q.exists()).scalar()


def _unique_name(db: Session, base: str) -> str:
    """Return `base` if free, otherwise append ` (copy)`, ` (copy 2)`, ... until unique."""
    if not _name_taken(db, base):
        return base
    for n in range(1, 1000):
        candidate = f"{base} (copy)" if n == 1 else f"{base} (copy {n})"
        if not _name_taken(db, candidate):
            return candidate
    raise HTTPException(status_code=409, detail="Unable to generate a unique config name")


@router.get("/configs")
def list_configs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return ALL configs (with is_owner flag). Own configs first, then others."""
    cfgs = (
        db.query(BNGConfig).order_by((BNGConfig.user_id == current_user.id).desc(), BNGConfig.created_at.desc()).all()
    )
    # Build owner username map
    owner_ids = list({c.user_id for c in cfgs})
    owner_map = {}
    if owner_ids:
        rows = db.query(User.id, User.username).filter(User.id.in_(owner_ids)).all()
        owner_map = {r.id: r.username for r in rows}
    return [_config_out(c, current_user.id, owner_map.get(c.user_id, "unknown")) for c in cfgs]


@router.post("/configs", status_code=201)
def create_config(
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator),
):
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Config name is required")
    if _name_taken(db, name):
        raise HTTPException(status_code=409, detail=f"Config name '{name}' is already in use")
    c = BNGConfig(
        user_id=current_user.id,
        name=name,
        description=data.get("description"),
        config_json=data.get("config_json", {}),
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return _config_out(c, current_user.id, current_user.username)


@router.post("/configs/{config_id}/clone", status_code=201)
def clone_config(
    config_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clone any config — creates a new copy owned by current user (auto-renamed to stay unique)."""
    orig = db.query(BNGConfig).filter(BNGConfig.id == config_id).first()
    if not orig:
        raise HTTPException(status_code=404, detail="Config not found")
    new_c = BNGConfig(
        user_id=current_user.id,
        name=_unique_name(db, orig.name),
        description=orig.description,
        config_json=orig.config_json,
    )
    db.add(new_c)
    db.commit()
    db.refresh(new_c)
    return _config_out(new_c, current_user.id, current_user.username)


@router.put("/configs/{config_id}")
def update_config(
    config_id: int,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    c = db.query(BNGConfig).filter(BNGConfig.id == config_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Config not found")
    if c.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not your config")
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Config name is required")
        if new_name != c.name and _name_taken(db, new_name, exclude_id=c.id):
            raise HTTPException(status_code=409, detail=f"Config name '{new_name}' is already in use")
        c.name = new_name
    if "description" in data:
        c.description = data["description"]
    if "config_json" in data:
        c.config_json = data["config_json"]
    db.commit()
    db.refresh(c)
    owner_name = db.query(User.username).filter(User.id == c.user_id).scalar() or ""
    return _config_out(c, current_user.id, owner_name)


@router.delete("/configs/{config_id}")
def delete_config(
    config_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    c = db.query(BNGConfig).filter(BNGConfig.id == config_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Config not found")
    if c.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not your config")
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── BNG server proxy endpoints ────────────────────────────────────────────────


@router.get("/servers/{server_id}/version")
async def get_version(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), "/api/v1/version", timeout=5.0)
    return data


@router.post("/servers/{server_id}/setup-interfaces")
async def setup_vlan_interfaces(
    server_id: int,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Extract VLAN subinterfaces from config_json and create them via SSH on the BNGBlaster server.

    Body: { "config_json": {...} }
    Returns: { "interfaces": [...], "results": [...] }
    """
    server = _require_server(server_id, db)
    if not server.ssh_user or not server.ssh_pass:
        raise HTTPException(status_code=400, detail="SSH credentials not configured for this server")

    config_json = data.get("config_json")
    if not config_json:
        raise HTTPException(status_code=400, detail="config_json is required")

    interfaces = _extract_vlan_interfaces(config_json)
    if not interfaces:
        return {"interfaces": [], "success": True, "message": "No VLAN subinterfaces found in config"}

    script = _build_vlan_script(interfaces)
    try:
        result = await _ssh_setup_vlans(server.host, server.ssh_user, decrypt_secret(server.ssh_pass or ""), script)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH connection error: {e}") from e

    return {
        "interfaces": sorted(interfaces),
        "script": script,
        "success": result["success"],
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "exit_code": result["exit_code"],
    }


@router.get("/servers/{server_id}/interfaces")
async def list_server_interfaces(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List available network interfaces on the BNGBlaster server."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), "/api/v1/interfaces", timeout=5.0)
    return data


@router.get("/servers/{server_id}/instances")
async def list_instances(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all instances. Normalises response to {instances, running-instances}."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), "/api/v1/instances")

    # BNGBlaster controller may return a list of objects or a dict — normalise.
    if isinstance(data, list):
        names = [i["name"] if isinstance(i, dict) else str(i) for i in data]
        running = [
            i["name"] if isinstance(i, dict) else str(i)
            for i in data
            if isinstance(i, dict) and i.get("status") in ("running", "started")
        ]
        return {"instances": names, "running-instances": running}
    # Already in expected dict format
    return data


@router.get("/servers/{server_id}/instances-with-status")
async def list_instances_with_status(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return [{name, status}] for all instances in a single round-trip to the frontend.

    Fetches the instance list then queries every status in parallel using one shared
    httpx.AsyncClient so backend→BNGBlaster connections are reused.
    """
    server = _require_server(server_id, db)
    base_url = _bng_url(server)

    # Step 1: get list of instance names
    _, data = await _proxy("GET", base_url, "/api/v1/instances")
    if isinstance(data, list):
        names: list[str] = [i["name"] if isinstance(i, dict) else str(i) for i in data]
    else:
        names = []

    if not names:
        return []

    # Step 2: fetch all statuses in parallel with a shared client (connection reuse)
    async def _fetch_status(client: httpx.AsyncClient, name: str) -> dict:
        try:
            r = await client.get(f"{base_url}/api/v1/instances/{name}", timeout=5.0)
            status = r.json().get("status", "unknown") if r.status_code == 200 else "unknown"
        except Exception:
            status = "unknown"
        return {"name": name, "status": status}

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[_fetch_status(client, n) for n in names])

    return list(results)


@router.get("/servers/{server_id}/instances/{instance}/status")
async def get_instance_status(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), f"/api/v1/instances/{instance}")
    return data


@router.get("/servers/{server_id}/instances/{instance}/config")
async def get_instance_config(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download the active config.json for an instance."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), f"/api/v1/instances/{instance}/config.json")
    return data


@router.put("/servers/{server_id}/instances/{instance}/config")
async def push_instance_config(
    server_id: int,
    instance: str,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or update an instance with the given config (PUT /api/v1/instances/{name})."""
    server = _require_server(server_id, db)
    status_code, resp = await _proxy("PUT", _bng_url(server), f"/api/v1/instances/{instance}", json_data=data)
    return {"status_code": status_code, "data": resp}


@router.delete("/servers/{server_id}/instances/{instance}")
async def delete_instance(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete an instance from the BNGBlaster controller."""
    server = _require_server(server_id, db)
    status_code, resp = await _proxy("DELETE", _bng_url(server), f"/api/v1/instances/{instance}")
    return {"status_code": status_code, "data": resp}


@router.post("/servers/{server_id}/instances/{instance}/start")
async def start_instance(
    server_id: int,
    instance: str,
    data: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = _require_server(server_id, db)
    payload = {
        "logging": True,
        "report": True,
        "report_flags": ["sessions", "streams"],
        **data,
    }
    status_code, resp = await _proxy(
        "POST", _bng_url(server), f"/api/v1/instances/{instance}/_start", json_data=payload
    )
    if status_code >= 400:
        raise HTTPException(status_code=status_code, detail=f"BNGBlaster _start failed: {resp}")
    return resp


@router.post("/servers/{server_id}/instances/{instance}/_start")
async def start_instance_with_config(
    server_id: int,
    instance: str,
    data: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Push config + start in one call.

    Body may include ``config_json`` (dict) which is first PUT to the BNGBlaster
    controller to create/update the instance, then ``_start`` is called.
    Any remaining keys (logging, report, etc.) are forwarded to ``_start``.
    """
    server = _require_server(server_id, db)
    config_json = data.pop("config_json", None)

    # 1. Push config if provided
    if config_json is not None:
        sc, resp = await _proxy("PUT", _bng_url(server), f"/api/v1/instances/{instance}", json_data=config_json)
        if sc >= 400:
            raise HTTPException(status_code=sc, detail=f"Failed to push config: {resp}")

    # 2. Start the instance
    start_payload = {
        "logging": True,
        "report": True,
        "report_flags": ["sessions", "streams"],
        **data,
    }
    status_code, resp = await _proxy(
        "POST", _bng_url(server), f"/api/v1/instances/{instance}/_start", json_data=start_payload
    )
    if status_code >= 400:
        raise HTTPException(status_code=status_code, detail=f"BNGBlaster _start failed: {resp}")
    return resp


@router.post("/servers/{server_id}/instances/{instance}/stop")
async def stop_instance(
    server_id: int,
    instance: str,
    data: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = _require_server(server_id, db)
    payload = {"logging": True, "report": True, "report_flags": ["sessions", "streams"], **data}
    status_code, resp = await _proxy("POST", _bng_url(server), f"/api/v1/instances/{instance}/_stop", json_data=payload)
    return {"status_code": status_code, "data": resp}


@router.post("/servers/{server_id}/instances/{instance}/kill")
async def kill_instance(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = _require_server(server_id, db)
    status_code, resp = await _proxy(
        "POST", _bng_url(server), f"/api/v1/instances/{instance}/_kill", json_data={"logging": True}
    )
    return {"status_code": status_code, "data": resp}


@router.post("/servers/{server_id}/instances/{instance}/command")
async def send_command(
    server_id: int,
    instance: str,
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Send a command to a running instance ctrl socket (e.g. network-interfaces, session-counters)."""
    server = _require_server(server_id, db)
    _, resp = await _proxy("POST", _bng_url(server), f"/api/v1/instances/{instance}/_command", json_data=data)
    return resp


@router.get("/servers/{server_id}/instances/{instance}/log")
async def get_instance_log(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download run.log for an instance."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), f"/api/v1/instances/{instance}/run.log", timeout=10.0)
    return {"log": data if isinstance(data, str) else str(data)}


@router.get("/servers/{server_id}/instances/{instance}/report")
async def get_instance_report(
    server_id: int,
    instance: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download run_report.json for an instance."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), f"/api/v1/instances/{instance}/run_report.json")
    return data


@router.get("/servers/{server_id}/instances/{instance}/files/{file_name}")
async def download_instance_file(
    server_id: int,
    instance: str,
    file_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download any output file from an instance (e.g. run.log, run_report.json, config.json)."""
    server = _require_server(server_id, db)
    _, data = await _proxy("GET", _bng_url(server), f"/api/v1/instances/{instance}/{file_name}", timeout=15.0)
    return data
