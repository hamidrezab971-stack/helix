import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("Set DATABASE_URL in the environment or backend/.env.")

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY or len(SECRET_KEY.encode("utf-8")) < 32:
    raise RuntimeError("Set SECRET_KEY to a random secret of at least 32 bytes.")

try:
    ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ["ACCESS_TOKEN_EXPIRE_MINUTES"])
except (KeyError, ValueError):
    raise RuntimeError("Set ACCESS_TOKEN_EXPIRE_MINUTES to a positive integer.") from None
if ACCESS_TOKEN_EXPIRE_MINUTES <= 0:
    raise RuntimeError("Set ACCESS_TOKEN_EXPIRE_MINUTES to a positive integer.")

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN")
if not FRONTEND_ORIGIN:
    raise RuntimeError("Set FRONTEND_ORIGIN in the environment or backend/.env.")

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads")).resolve()
