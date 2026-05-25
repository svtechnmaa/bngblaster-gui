"""Global (system-wide) settings — single-row table, admin-managed.

Used for integrations that apply to the whole installation (e.g. Git backup of
all BNGBlaster configs) rather than a single user's preferences.
"""

from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class GlobalSetting(Base):
    __tablename__ = "global_settings"

    # Single-row pattern — always id=1.
    id = Column(Integer, primary_key=True, index=True)

    # Git backup integration (admin-configured)
    git_repo_url = Column(String(512), nullable=True)
    git_branch = Column(String(100), nullable=True, default="main")
    git_token_enc = Column(String(1024), nullable=True)  # Fernet-encrypted PAT

    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    updated_by = Column(Integer, nullable=True)  # user_id of last editor
