// Isolated, loopback-only development preview. Never loads backend/.env or
// production storage: all data/uploads live in a new temporary directory.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backend = resolve(root, '../backend'), python = join(backend, '.venv/bin/python')
const frontendPort = 5190, backendPort = 8190
const phase = process.argv.includes('--phase20') ? '20' : '19'
let vite, child, temporary, stopping
async function available(port) {
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
  await new Promise(resolve => probe.close(resolve))
}
async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    if (vite) await vite.close()
    if (child && child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })()
  return stopping
}
async function main() {
  await access(python, constants.X_OK)
  await available(frontendPort); await available(backendPort)
  temporary = await mkdtemp(join(tmpdir(), `helix-phase${phase}-preview-`))
  vite = await createServer({
    configFile: false, envFile: false, root, plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(''), 'import.meta.env.VITE_WS_URL': JSON.stringify('') },
    server: { host: '127.0.0.1', port: frontendPort, strictPort: true, proxy: {
      '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    } },
  })
  await vite.listen()
  child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(backendPort)], {
    cwd: backend, stdio: 'inherit', env: {
      PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8',
      DATABASE_URL: `sqlite:///${temporary}/preview.db`, UPLOAD_DIR: join(temporary, 'uploads'),
      SECRET_KEY: randomBytes(48).toString('base64url'), ACCESS_TOKEN_EXPIRE_MINUTES: '120',
      CAPTCHA_KEY: randomBytes(48).toString('base64url'), PROFILE_MAX_PHOTOS: '10',
      FRONTEND_ORIGIN: `http://127.0.0.1:${frontendPort}`, FRONTEND_DIST_DIR: '', PYTHON_DOTENV_DISABLED: '1',
    },
  })
  child.once('error', error => { console.error(error.message); process.exitCode = 1; void stop() })
  child.once('exit', () => { if (!stopping) { process.exitCode = 1; void stop() } })
  let ready = false
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { if ((await fetch(`http://127.0.0.1:${backendPort}/api/health`)).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('Isolated preview backend did not start.')
  console.log(`\nHelix Phase ${phase}: http://127.0.0.1:${frontendPort}\nRegister a test account. Data is temporary and removed on Ctrl+C.\n`)
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
main().catch(async error => { console.error(`Preview unavailable: ${error.message}`); process.exitCode = 1; await stop() })
