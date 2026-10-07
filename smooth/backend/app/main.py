from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.auth import router as auth_router
from app.database.database import engine
from app.models.user import User


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    User.metadata.create_all(bind=engine)
    try:
        yield
    finally:
        engine.dispose()


app = FastAPI(title="Smooth API", lifespan=lifespan)
app.include_router(auth_router)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Keep submitted passwords out of validation responses.
    errors = [
        {key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Smooth API is running"}
