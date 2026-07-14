"""SQLAlchemy engine, session, base, and lightweight migrations."""

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings

settings = get_settings()

connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    echo=settings.DEBUG,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create tables and run lightweight column migrations."""
    # Import here so models register with Base.metadata before create_all.
    from app.models.bngblaster import BNGConfig, BNGServer  # noqa: F401
    from app.models.global_settings import GlobalSetting  # noqa: F401
    from app.models.metrics import PageView  # noqa: F401
    from app.models.settings import AppSetting  # noqa: F401
    from app.models.user import User  # noqa: F401

    Base.metadata.create_all(bind=engine)

    # Idempotent migrations for SSO + SSH columns when the schema predates them.
    is_pg = settings.DATABASE_URL.startswith("postgres")
    if not is_pg:
        return

    with engine.begin() as conn:
        for col, typ in [("ssh_user", "VARCHAR(255)"), ("ssh_pass", "VARCHAR(255)")]:
            conn.execute(text(f"ALTER TABLE bng_servers ADD COLUMN IF NOT EXISTS {col} {typ}"))
        for col, typ in [
            ("auth_provider", "VARCHAR(20) NOT NULL DEFAULT 'local'"),
            ("provider_id", "VARCHAR(255)"),
            ("avatar_url", "VARCHAR(512)"),
        ]:
            conn.execute(text(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {typ}"))
        conn.execute(text(
            "ALTER TABLE bng_configs ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))
