"""SQLAlchemy model for application users."""

from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(255), unique=True, nullable=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    role = Column(String(50), nullable=False, default="operator")  # admin, operator, viewer
    is_active = Column(Integer, default=1)
    # SSO fields
    auth_provider = Column(String(20), nullable=False, default="local")  # local|google|keycloak
    provider_id = Column(String(255), nullable=True, index=True)  # sub from OAuth provider
    avatar_url = Column(String(512), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
