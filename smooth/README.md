# Smooth

Smooth is a lightweight web-based messaging application. Phase 7 adds persistent
one-to-one conversations and text messaging through HTTP. Real-time updates and
WebSockets are not implemented yet.

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
│   │   │   ├── auth.py
│   │   │   ├── users.py
│   │   │   └── conversations.py
│   │   ├── models/
│   │   │   ├── user.py
│   │   │   ├── conversation.py
│   │   │   ├── conversation_member.py
│   │   │   └── message.py
│   │   ├── schemas/
│   │   │   ├── auth.py
│   │   │   └── conversations.py
│   │   ├── services/
│   │   ├── database/
│   │   │   └── database.py
│   │   └── core/
│   │       ├── auth.py
│   │       ├── config.py
│   │       └── security.py
│   ├── requirements.txt
│   ├── .env.example
│   └── .gitignore
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuthCard.jsx
│   │   │   └── ChatPanel.jsx
│   │   ├── pages/
│   │   │   ├── LoginPage.jsx
│   │   │   ├── RegisterPage.jsx
│   │   │   └── HomePage.jsx
│   │   ├── services/
│   │   │   └── api.js
│   │   ├── hooks/
│   │   ├── utils/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   ├── package-lock.json
│   ├── .env.example
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
python -c 'import secrets; from dotenv import set_key; set_key(".env", "SECRET_KEY", secrets.token_urlsafe(48))'
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
For a fresh checkout, the setup command writes a random signing secret directly
to `.env` without displaying it. Preserve existing `.env` values on later runs.
`SECRET_KEY` must be at least 32 bytes. `ACCESS_TOKEN_EXPIRE_MINUTES` configures
token lifetime; the example uses 1440 minutes (24 hours).
`FRONTEND_ORIGIN=http://127.0.0.1:5173` allows requests from the development
frontend. Existing installations must add this setting to `backend/.env` and
restart the backend. If using `localhost`, set it to `http://localhost:5173` and
open that matching frontend URL. CORS allows only this origin, GET/POST, and the
Authorization and Content-Type headers; cookies are not used.

Startup creates missing tables through SQLAlchemy metadata. The `users` table has
an automatically generated integer `id`, a required unique indexed `username`
(1–50 characters), a required `password_hash` (`String(255)`), and a `created_at`
datetime set automatically by the database in UTC. No users are seeded.

## Authentication API

`POST /api/auth/register` accepts JSON:

```json
{"username": "john", "password": "mypassword123"}
```

Usernames are trimmed, converted to lowercase, and validated as 3–30 characters
using only `a-z`, `0-9`, and `_`. Passwords must be 8–128 characters and are stored
as Argon2id hashes using argon2-cffi. Success returns HTTP 201 with only `id`,
`username`, and `created_at`. Duplicate usernames return HTTP 409; invalid input
returns HTTP 422. Registration does not create a token or session.

`POST /api/auth/login` accepts the same JSON fields and normalizes the username.
Correct credentials return `access_token` and `token_type: "bearer"`. Unknown
usernames and wrong passwords both return HTTP 401 with
`"Invalid username or password"`. Tokens use HS256 and contain only `sub`,
`username`, `iat`, and `exp`.

`GET /api/auth/me` requires `Authorization: Bearer <token>` and returns only
`id`, `username`, and `created_at`. Missing, invalid, expired tokens and tokens
for deleted users return HTTP 401. No refresh tokens or server-side logout
endpoint are implemented.

`GET /api/users` requires `Authorization: Bearer <token>`. It returns only `id`,
`username`, and `created_at` for up to 50 other users, ordered by username then ID.
The current user is excluded. Optional `?search=<username>` performs a
case-insensitive partial username search with surrounding whitespace trimmed;
empty or whitespace-only search returns the normal directory. Missing, invalid,
or expired tokens return HTTP 401.

## HTTP messaging API

All endpoints require `Authorization: Bearer <token>`:

- `POST /api/conversations/with/{user_id}` creates a direct conversation (201) or
  returns the existing one (200), with `id`, `created_at`, and safe `other_user`
  fields. Self-conversations return 400; nonexistent users return 404. A unique
  canonical user pair prevents duplicates; both members are created atomically.
- `GET /api/conversations/{conversation_id}/messages` returns safe message fields
  (`id`, `conversation_id`, `sender_id`, `content`, `created_at`), ordered by
  `created_at` then `id`, ascending.
- `POST /api/conversations/{conversation_id}/messages` accepts
  `{"content":"Hello"}` and returns the stored message with 201. Content is trimmed
  and must contain 1–2000 characters; invalid content returns 422.

History and sending require membership; inaccessible or nonexistent conversations
return 404. Missing, invalid, or expired tokens return 401. Startup creates the
new tables in the existing SQLite database and enables foreign-key enforcement.
There are no seeded messages, polling, or WebSockets. History loads when a user
is selected (including reselecting the same user); sending appends the returned
message. Reopen the conversation to see another user's new messages.

## Run the frontend

In a separate terminal, from `smooth/`:

```bash
cd frontend
npm install
cp .env.example .env
npm run dev -- --host 127.0.0.1
```

Set `VITE_API_URL=http://127.0.0.1:8000` in `frontend/.env` (the same value is the
local fallback). Restart Vite after changing it. Keep existing environment files
when rerunning the setup commands.

Open http://127.0.0.1:5173/ to register or log in. Registration returns to login;
successful login loads the current user through `/api/auth/me`. Only the access
token is saved in localStorage as `smooth_access_token`. Refresh verifies it
again; invalid or expired tokens are removed. Log out clears it on the client.
The authenticated directory searches after a short typing delay. Selecting a
user opens their real conversation and message history. Send text with the Send
button or Enter; Shift+Enter inserts a new line. Switching users replaces history
and clears the draft. Authentication failures clear the session and return to login.
Build the frontend with `npm run build`.
