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

# Set only when serving the production frontend from the API process.
_frontend_dist_dir = os.getenv("FRONTEND_DIST_DIR")
FRONTEND_DIST_DIR = Path(_frontend_dist_dir).resolve() if _frontend_dist_dir else None

# Domain-separated from JWT signing. A dedicated random key may be supplied
# without rotating existing JWTs; it never enters the source or API response.
import hashlib
import hmac
CAPTCHA_KEY = os.getenv('CAPTCHA_KEY') or hmac.new(SECRET_KEY.encode(), b'helix/altcha/v20', hashlib.sha256).hexdigest()
if len(CAPTCHA_KEY.encode()) < 32:
    raise RuntimeError('CAPTCHA_KEY must contain at least 32 bytes.')
PROFILE_MAX_PHOTOS = int(os.getenv('PROFILE_MAX_PHOTOS', '10'))
if not 1 <= PROFILE_MAX_PHOTOS <= 50:
    raise RuntimeError('PROFILE_MAX_PHOTOS must be between 1 and 50.')
