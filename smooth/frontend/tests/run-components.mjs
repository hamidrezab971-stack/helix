// Compile JSX with the installed Vite toolchain, then run node:test. No server,
// additional test framework, network, production account or database is used.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = await mkdtemp(join(root, '.phase19-test-'))
try {
  await build({
    configFile: false, root, logLevel: 'error', plugins: [react()],
    build: { ssr: join(root, 'tests/phase19-components.jsx'), outDir: output, emptyOutDir: true, minify: false },
  })
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(output, 'phase19-components.js')], { cwd: root, stdio: 'inherit' })
    child.once('error', reject); child.once('exit', resolve)
  })
  if (code !== 0) process.exitCode = 1
} finally { await rm(output, { recursive: true, force: true }) }
