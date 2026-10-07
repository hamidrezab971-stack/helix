# Smooth

Smooth is a lightweight web-based messaging application. Phase 1 provides the
project structure, a running API, and a simple landing screen. Authentication,
profiles, messaging, database models, and WebSockets are reserved for later phases.

## Technology stack

- Backend: Python 3.12+, FastAPI, Uvicorn, SQLAlchemy, and SQLite.
- Frontend: React, JavaScript, [Vite](https://vite.dev/guide/), and
  [Tailwind CSS](https://tailwindcss.com/docs/installation/using-vite).
- Development: Git, environment files, and npm. Use Node.js 22.12+.

SQLAlchemy and python-dotenv are installed for future phases; no database or
environment configuration logic is implemented yet.

## Project structure

```text
smooth/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── api/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── services/
│   │   ├── database/
│   │   └── core/
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

The `.env` file contains development placeholders only and is ignored by Git.
It is not loaded by the Phase 1 entry point.

## Run the frontend

In a separate terminal, from `smooth/`:

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/ to see **Smooth** and
**A modern messaging application.** Build the frontend with `npm run build`.
