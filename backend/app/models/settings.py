"""SQLAlchemy model for per-user application settings."""

from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, unique=True, index=True)

    # BNGBlaster integration
    bngblaster_url = Column(String(512), nullable=True, default="http://localhost:8881")
    bng_ssh_user = Column(String(255), nullable=True)
    bng_ssh_pass = Column(String(255), nullable=True)

    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
