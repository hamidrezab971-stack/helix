from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.api.auth import router as auth_router
from app.api.attachments import router as attachments_router
from app.api.conversations import router as conversations_router
from app.api.messages import router as messages_router
from app.api.realtime import router as realtime_router
from app.api.users import router as users_router
from app.core.config import FRONTEND_DIST_DIR, FRONTEND_ORIGIN
from app.database.database import Base, engine
from app.services.receipts import initialize_receipts
from app.database.migrations import migrate_phase17, migrate_phase18
from app.api.timeline import router as timeline_router
from app.api.profiles import router as profiles_router
from app.database.phase20 import migrate_phase20
from app.database.phase204 import migrate_phase204
from app.core.body_limits import IdentityBodyLimit
from app.services.profile_images import collect
from app.core.metrics import MetricsMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    Base.metadata.create_all(bind=engine)
    migrate_phase17(engine)
    migrate_phase18(engine)
    migrate_phase20(engine)
    migrate_phase204(engine)
    collect()
    initialize_receipts()
    try:
        yield
    finally:
        engine.dispose()


app = FastAPI(title="Smooth API", lifespan=lifespan)
app.add_middleware(IdentityBodyLimit)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(auth_router)
app.include_router(attachments_router)
app.include_router(users_router)
app.include_router(profiles_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(timeline_router)
app.include_router(realtime_router)

# Templates are captured from registered API routes, never from request URLs.
app.add_middleware(MetricsMiddleware, routes=frozenset({'/api/health'} | {
    route.path for router in (auth_router, attachments_router, users_router,
        profiles_router, conversations_router, messages_router, timeline_router)
    for route in router.routes if getattr(route, 'path', '').startswith('/api/')
}))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Keep submitted passwords out of validation responses.
    errors = [
        {key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})


@app.get("/api/health", include_in_schema=False)
def health() -> dict[str, str]:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"status": "ok"}


if FRONTEND_DIST_DIR is not None:
    if not (FRONTEND_DIST_DIR / "index.html").is_file():
        raise RuntimeError("FRONTEND_DIST_DIR must contain a built frontend index.html.")
    # Mount last so API and WebSocket routes keep priority.
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
else:
    @app.get("/")
    async def root() -> dict[str, str]:
        return {"message": "Smooth API is running"}
