"""BNGBlaster Web Client — FastAPI entry point."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import admin_settings, auth, bngblaster, metrics, sso
from app.api.v1 import settings as settings_router
from app.core.config import get_settings
from app.core.database import SessionLocal, init_db
from app.core.security import get_password_hash
from app.models.user import User

settings = get_settings()
log = logging.getLogger(__name__)

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

prefix = settings.API_V1_PREFIX
app.include_router(auth.router, prefix=prefix)
app.include_router(sso.router, prefix=prefix)
app.include_router(bngblaster.router, prefix=prefix)
app.include_router(metrics.router, prefix=prefix)
app.include_router(settings_router.router, prefix=prefix)
app.include_router(admin_settings.router, prefix=prefix)


@app.on_event("startup")
def _startup():
    init_db()
    _seed_default_admin()


def _seed_default_admin():
    db = SessionLocal()
    try:
        if not db.query(User).filter(User.username == "admin").first():
            db.add(
                User(
                    username="admin",
                    password_hash=get_password_hash("admin123"),
                    email="admin@localhost",
                    full_name="Administrator",
                    role="admin",
                )
            )
            db.commit()
            log.info("Seeded default admin user (username=admin, password=admin123)")
    finally:
        db.close()


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "version": settings.APP_VERSION, "docs": "/docs"}


@app.get("/health")
def health():
    from sqlalchemy import text

    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "detail": str(exc)[:200]}
    finally:
        db.close()
