"""Page-view tracking and dashboard statistics."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Body, Depends, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.bngblaster import BNGConfig, BNGServer
from app.models.metrics import PageView
from app.models.user import User

router = APIRouter(tags=["Metrics"])


@router.post("/metrics/pageview", status_code=204)
def track_pageview(
    data: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a page view for the current user. F5/reload each counts as 1."""
    path = (data.get("path") or "")[:255]
    db.add(PageView(user_id=current_user.id, path=path))
    db.commit()
    return Response(status_code=204)


@router.get("/dashboard/stats")
def dashboard_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregated stats for the Dashboard tab. Response shape varies by role."""
    now = datetime.now(UTC)
    since_7d = now - timedelta(days=7)
    since_30d = now - timedelta(days=30)

    totals = {
        "users": db.query(func.count(User.id)).scalar() or 0,
        "servers": db.query(func.count(BNGServer.id)).scalar() or 0,
        "configs": db.query(func.count(BNGConfig.id)).scalar() or 0,
        "pageviews_7d": db.query(func.count(PageView.id)).filter(PageView.viewed_at >= since_7d).scalar() or 0,
        "pageviews_30d": db.query(func.count(PageView.id)).filter(PageView.viewed_at >= since_30d).scalar() or 0,
    }

    # Pageviews per day for last 30 days — array of {date: YYYY-MM-DD, count: int}
    daily_rows = (
        db.query(func.date(PageView.viewed_at).label("d"), func.count(PageView.id))
        .filter(PageView.viewed_at >= since_30d)
        .group_by("d")
        .order_by("d")
        .all()
    )
    daily = [{"date": str(d), "count": int(c)} for d, c in daily_rows]

    # Own config count — every role can see this
    own_configs = db.query(func.count(BNGConfig.id)).filter(BNGConfig.user_id == current_user.id).scalar() or 0

    response: dict = {
        "totals": totals,
        "pageviews_daily": daily,
        "own_configs": own_configs,
        "role": current_user.role,
    }

    # admin + operator see user breakdown and top owners
    if current_user.role in ("admin", "operator"):
        users_by_role_rows = db.query(User.role, func.count(User.id)).group_by(User.role).all()
        response["users_by_role"] = [{"role": r, "count": int(c)} for r, c in users_by_role_rows]

        users_by_provider_rows = db.query(User.auth_provider, func.count(User.id)).group_by(User.auth_provider).all()
        response["users_by_provider"] = [{"provider": p, "count": int(c)} for p, c in users_by_provider_rows]

        top_owners_rows = (
            db.query(User.username, func.count(BNGConfig.id).label("n"))
            .join(BNGConfig, BNGConfig.user_id == User.id)
            .group_by(User.username)
            .order_by(func.count(BNGConfig.id).desc())
            .limit(5)
            .all()
        )
        response["top_config_owners"] = [{"username": u, "count": int(n)} for u, n in top_owners_rows]

        active_7d = (
            db.query(func.count(func.distinct(PageView.user_id))).filter(PageView.viewed_at >= since_7d).scalar() or 0
        )
        response["active_users_7d"] = int(active_7d)

    return response
