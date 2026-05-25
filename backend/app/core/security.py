"""
JWT authentication and password hashing utilities.
Uses bcrypt directly (avoids passlib Python 3.11 incompatibility).
"""

from datetime import UTC, datetime, timedelta

import bcrypt
from fastapi import HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

from .config import get_settings

settings = get_settings()

# ── OAuth2 scheme ────────────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_PREFIX}/auth/login")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def get_password_hash(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


# Alias used by workflow project's deps.py pattern
decode_token = decode_access_token


# ── Fernet secret encryption (workflow device passwords) ─────────────────────


def encrypt_secret(value: str) -> str:
    """Encrypt a secret string using Fernet symmetric encryption.
    If FERNET_KEY is not configured, returns the value as-is.
    """
    if not settings.FERNET_KEY:
        return value
    try:
        from cryptography.fernet import Fernet

        f = Fernet(settings.FERNET_KEY.encode())
        return f.encrypt(value.encode()).decode()
    except Exception:
        return value


def decrypt_secret(value: str) -> str:
    """Decrypt a Fernet-encrypted secret string.
    If FERNET_KEY is not configured or decryption fails, returns the value as-is
    (backward compatible with plaintext passwords).
    """
    if not settings.FERNET_KEY:  # handles both None and empty string
        return value
    try:
        from cryptography.fernet import Fernet

        f = Fernet(settings.FERNET_KEY.encode())
        return f.decrypt(value.encode()).decode()
    except Exception:
        # If decryption fails, the value is likely stored as plaintext
        return value
