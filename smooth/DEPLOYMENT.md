# Deploy Smooth

Smooth runs as one Docker service: FastAPI serves the built React frontend,
`/api`, and `/ws` on the same origin. The image builds with Node 22 and runs
with Python 3.12. Keep one worker and one replica because realtime presence
and typing state are process-local.

## Railway

1. Connect the GitHub repository and select the branch containing these files.
   Use the repository root as the service root; the `Dockerfile` and
   `railway.toml` are there.
2. Attach a persistent volume at `/data` before accepting users. The Docker
   image stores the SQLite database at `/data/smooth.db` and image uploads at
   `/data/uploads`. A directory inside the container alone does not persist
   across deployments. Configure volume backups in the hosting account.
3. Generate a Railway public domain for the service and use port `8000`.
4. Set these service variables before deployment:

   | Variable | Value |
   | --- | --- |
   | `SECRET_KEY` | A newly generated random secret of at least 32 bytes |
   | `FRONTEND_ORIGIN` | The exact HTTPS app origin, without a trailing slash |
   | `PORT` | `8000` |

   Generate the secret locally with
   `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'` and save it
   only in the provider's secret settings. Preserve it across deployments.
   For the generated Railway domain, `FRONTEND_ORIGIN` can use the reference
   `https://${{RAILWAY_PUBLIC_DOMAIN}}`. The image already sets the database,
   upload, frontend, and token-lifetime defaults.
5. Deploy. Railway checks `/api/health` before routing traffic. Confirm the
   homepage loads, then register two accounts and check message delivery in
   two browser profiles. Restart the service and confirm history and uploaded
   images remain available.

Railway's generated domain is an app subdomain, not a purchased custom domain.
Hosting and persistent volume usage follow the account's plan and billing.

## Custom domain

Add a domain you own in the service's public networking settings, then create
the exact DNS records Railway returns at your DNS provider. Wait for domain
verification and HTTPS, update `FRONTEND_ORIGIN` to that domain's HTTPS origin,
and redeploy. Use that origin for the app so WebSocket origin checks match.
Buying a new domain requires a registrar account and a selected domain name.

## Run the production container locally

From the repository root, with Docker installed:

```bash
docker build -t smooth .
docker volume create smooth-data
```

Create an ignored environment file at `smooth/.env.production`:

```dotenv
SECRET_KEY=<your-generated-secret>
FRONTEND_ORIGIN=http://localhost:8000
```

Then start the app:

```bash
docker run --detach --name smooth --restart unless-stopped \
  --env-file smooth/.env.production \
  --publish 8000:8000 --volume smooth-data:/data smooth
```

Open `http://localhost:8000`. `GET /api/health` returns `{"status":"ok"}` when
the application can query its database. Frontend API and WebSocket URLs stay
empty so they use the same origin. Existing separate frontend/backend
development commands continue to work without `FRONTEND_DIST_DIR`.

References: [Railway Docker builds](https://docs.railway.com/builds/dockerfiles),
[deployment configuration](https://docs.railway.com/config-as-code/reference),
[persistent volumes](https://docs.railway.com/volumes), and
[public networking and domains](https://docs.railway.com/networking/public-networking).

## HELIX VPS Phase 21.2 candidate

For the audited VPS transition use [infra/README.md](../infra/README.md).
The root Dockerfile now requires digest-pinned NODE_IMAGE and PYTHON_IMAGE
build arguments and an existing database; the historical Railway/local volume
quickstart above is not compatible with this safety policy. VPS production
cutover requires the inventory, real isolated rehearsal and explicit approval.
