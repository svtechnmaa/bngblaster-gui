"""Pydantic schemas for authentication and users."""

from datetime import datetime

from pydantic import BaseModel, field_validator


# ── Auth ─────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserResponse"


# ── User ─────────────────────────────────────────────────
class UserCreate(BaseModel):
    username: str
    password: str
    email: str | None = None
    full_name: str | None = None
    role: str = "operator"

    @field_validator("email", "full_name", mode="before")
    @classmethod
    def empty_to_none(cls, v: str | None) -> str | None:
        if isinstance(v, str) and not v.strip():
            return None
        return v


class UserUpdate(BaseModel):
    email: str | None = None
    full_name: str | None = None
    role: str | None = None
    is_active: int | None = None

    @field_validator("email", "full_name", mode="before")
    @classmethod
    def empty_to_none(cls, v: str | None) -> str | None:
        if isinstance(v, str) and not v.strip():
            return None
        return v


class UserResponse(BaseModel):
    id: int
    username: str
    email: str | None
    full_name: str | None
    role: str
    is_active: int
    auth_provider: str = "local"
    avatar_url: str | None = None
    created_at: datetime | None

    class Config:
        from_attributes = True
