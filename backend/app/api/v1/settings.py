"""App settings API — per-user configuration stored in the database."""

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.settings import AppSetting
from app.models.user import User

router = APIRouter(prefix="/settings", tags=["Settings"])


def _get_or_create(user_id: int, db: Session) -> AppSetting:
    setting = db.query(AppSetting).filter(AppSetting.user_id == user_id).first()
    if not setting:
        setting = AppSetting(user_id=user_id)
        db.add(setting)
        db.commit()
        db.refresh(setting)
    return setting


def _setting_out(s: AppSetting) -> dict:
    return {
        "bngblaster_url": s.bngblaster_url or "http://localhost:8881",
        "bng_ssh_user": s.bng_ssh_user or "",
        "bng_ssh_pass": s.bng_ssh_pass or "",
        "updated_at": s.updated_at,
    }


@router.get("")
def get_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the current user's saved settings."""
    setting = _get_or_create(current_user.id, db)
    return _setting_out(setting)


@router.put("")
def update_settings(
    data: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update the current user's settings. Only provided keys are updated."""
    setting = _get_or_create(current_user.id, db)

    if "bngblaster_url" in data:
        setting.bngblaster_url = data["bngblaster_url"] or None
    if "bng_ssh_user" in data:
        setting.bng_ssh_user = data["bng_ssh_user"] or None
    if "bng_ssh_pass" in data:
        setting.bng_ssh_pass = data["bng_ssh_pass"] or None

    db.commit()
    db.refresh(setting)
    return _setting_out(setting)
