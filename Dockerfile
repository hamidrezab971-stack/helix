FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY smooth/frontend/package.json smooth/frontend/package-lock.json ./
RUN npm ci
COPY smooth/frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    ACCESS_TOKEN_EXPIRE_MINUTES=1440 \
    DATABASE_URL=sqlite:////data/smooth.db \
    UPLOAD_DIR=/data/uploads \
    FRONTEND_DIST_DIR=/app/frontend/dist
WORKDIR /app/backend
COPY smooth/backend/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY smooth/backend/app/ ./app/
COPY --from=frontend /build/frontend/dist/ /app/frontend/dist/
RUN mkdir -p /data/uploads
EXPOSE 8000
# Realtime presence is process-local; run exactly one worker and one replica.
CMD ["sh", "-c", "exec python -m uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1"]
