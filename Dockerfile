# Required digest references are resolved by infra/scripts/lock-images.py.
ARG NODE_IMAGE
ARG PYTHON_IMAGE
FROM scratch AS wheelhouse
COPY smooth/backend/requirements.lock /requirements.lock

FROM ${NODE_IMAGE} AS frontend
WORKDIR /build/frontend
COPY smooth/frontend/package.json smooth/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY smooth/frontend/ ./
RUN npm run build

FROM ${PYTHON_IMAGE} AS python-deps
ARG PIP_NO_INDEX=0
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY smooth/backend/requirements.lock ./
RUN --mount=type=bind,from=wheelhouse,target=/wheelhouse,ro \
 python -m pip download --find-links=/wheelhouse --only-binary=:all: --require-hashes -r requirements.lock -d /wheels \
 && python -m venv /venv \
 && /venv/bin/pip install --no-index --find-links=/wheels --require-hashes -r requirements.lock

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PATH=/venv/bin:$PATH PORT=8000 ACCESS_TOKEN_EXPIRE_MINUTES=1440 \
    DATABASE_URL=sqlite:////data/smooth.db UPLOAD_DIR=/data/uploads \
    FRONTEND_DIST_DIR=/app/frontend/dist
WORKDIR /app/backend
COPY --from=python-deps /venv /venv
COPY smooth/backend/app/ ./app/
COPY --from=frontend /build/frontend/dist/ /app/frontend/dist/
COPY infra/scripts/container-entrypoint.py /app/container-entrypoint.py
RUN groupadd --gid 10001 helix && useradd --uid 10001 --gid helix --no-create-home helix \
 && mkdir -p /data/uploads && chown -R helix:helix /data
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3).read()"]
ENTRYPOINT ["python", "/app/container-entrypoint.py"]
