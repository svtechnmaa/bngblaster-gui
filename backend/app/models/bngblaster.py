"""SQLAlchemy models for BNGBlaster servers and test configurations."""

from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON

from app.core.database import Base


class BNGServer(Base):
    __tablename__ = "bng_servers"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    host = Column(String(255), nullable=False)
    port = Column(Integer, nullable=False, default=8001)
    ssh_user = Column(String(255), nullable=True)
    ssh_pass = Column(String(255), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class BNGConfig(Base):
    __tablename__ = "bng_configs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    config_json = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
