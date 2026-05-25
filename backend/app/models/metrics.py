"""SQLAlchemy model for page-view metrics."""

from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class PageView(Base):
    __tablename__ = "page_views"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    path = Column(String(255), nullable=True)
    viewed_at = Column(DateTime, server_default=func.now(), index=True)
