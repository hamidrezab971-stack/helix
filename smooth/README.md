# Smooth

Smooth is a lightweight web-based messaging application. Phase 3 adds user
registration to the existing SQLite-backed API and landing screen. Login,
profiles, messaging, and WebSockets are reserved for later phases.

## Technology stack

- Backend: Python 3.12+, FastAPI, Uvicorn, SQLAlchemy, and SQLite.
- Frontend: React, JavaScript, [Vite](https://vite.dev/guide/), and
  [Tailwind CSS](https://tailwindcss.com/docs/installation/using-vite).
- Development: Git, environment files, and npm. Use Node.js 22.12+.

The backend uses the existing SQLAlchemy and python-dotenv dependencies for
database setup and environment configuration.

## Project structure

```text
smooth/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── api/
│   │   │   └── auth.py
│   │   ├── models/
│   │   │   └── user.py
│   │   ├── schemas/
│   │   │   └── auth.py
│   │   ├── services/
│   │   ├── database/
│   │   │   └── database.py
│   │   └── core/
│   │       └── security.py
│   ├── requirements.txt
│   ├── .env.example
│   └── .gitignore
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── services/
│   │   ├── hooks/
│   │   ├── utils/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   ├── package-lock.json
│   └── .gitignore
├── README.md
└── .gitignore
```

Empty Python package files and `.gitkeep` files preserve the directory structure
in Git without implementing future features.

## Run the backend

From the `smooth/` directory:

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On Windows, use `py -3.12 -m venv .venv` and `.venv\Scripts\Activate.ps1`
in PowerShell. A newer Python version can also be used.
On Debian/Ubuntu, install `python3.12-venv` if the environment reports that
`ensurepip` is missing.

Open http://127.0.0.1:8000/ to see:

```json
{"message": "Smooth API is running"}
```

The backend loads `backend/.env`; existing environment variables take precedence.
Set `DATABASE_URL` using the value in `.env.example`. With the example SQLite URL,
starting from `backend/` creates `backend/smooth.db`. Both `.env` and `*.db` are
ignored by Git.

Startup creates missing tables through SQLAlchemy metadata. The `users` table has
an automatically generated integer `id`, a required unique indexed `username`
(1–50 characters), a required `password_hash` (`String(255)`), and a `created_at`
datetime set automatically by the database in UTC. No users are seeded.

## Registration API

`POST /api/auth/register` accepts JSON:

```json
{"username": "john", "password": "mypassword123"}
```

Usernames are trimmed, converted to lowercase, and validated as 3–30 characters
using only `a-z`, `0-9`, and `_`. Passwords must be 8–128 characters and are stored
as Argon2id hashes using argon2-cffi. Success returns HTTP 201 with only `id`,
`username`, and `created_at`. Duplicate usernames return HTTP 409; invalid input
returns HTTP 422. Registration does not create a token or session.

## Run the frontend

In a separate terminal, from `smooth/`:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/ to see **Smooth** and
**A modern messaging application.** Build the frontend with `npm run build`.
