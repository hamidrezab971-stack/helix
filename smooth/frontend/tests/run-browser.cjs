// Build once and serve the shipping assets for isolated browser regressions.
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const assertPortFree = require('./ports.cjs')
const { redactStream } = require('./browser-diagnostics.cjs')
const root = path.resolve(__dirname,'..')
let vite, child
function loggedSpawn(args, env) {
  const processChild = spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe'],env})
  // Buffer complete lines so tokens split across stream chunks are still masked.
  for (const [stream, output] of [[processChild.stdout,process.stdout],[processChild.stderr,process.stderr]]) {
    redactStream(stream, output)
  }
  return processChild
}
async function stop() {
  if(child && child.exitCode === null) child.kill('SIGTERM')
  if(vite && vite.exitCode === null) {
    const done = new Promise(resolve => vite.once('exit',resolve)); vite.kill('SIGTERM'); await done
  }
}
async function main() {
  process.env.HELIX_BROWSER_ARTIFACTS ||= fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-browser-evidence-'))
  console.log(`Browser evidence directory: ${process.env.HELIX_BROWSER_ARTIFACTS}`)
  await assertPortFree(5173)
  const viteCli = path.join(root,'node_modules/vite/bin/vite.js')
  const frontendEnv = {...process.env,VITE_API_URL:'',VITE_WS_URL:''}
  const buildCode = await new Promise((resolve,reject) => {
    child = loggedSpawn([viteCli,'build'],frontendEnv)
    child.once('error',reject); child.once('exit',resolve)
  })
  if (buildCode !== 0) throw new Error(`Browser production build failed (exit ${buildCode})`)
  vite = loggedSpawn([viteCli,'preview','--host','127.0.0.1','--port','5173','--strictPort'],frontendEnv)
  let ready = false
  for(let i=0;i<100;i++) {
    if(vite.exitCode !== null) throw new Error('Vite failed to start; use Node >=22.12 and npm ci, with port 5173 free.')
    try { if((await fetch('http://127.0.0.1:5173')).ok) {ready=true;break} } catch {}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(!ready) throw new Error('Frontend startup timed out')
  const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['phase8','phase17','phase18','phase19','phase191','phase20','phase204','phase211']
  for(const phase of phases) {
    if(!['phase8','phase17','phase18','phase19','phase191','phase20','phase204','phase211'].includes(phase)) throw new Error('Unknown browser regression phase')
    const code = await new Promise((resolve,reject) => {
      child=loggedSpawn([path.join(__dirname,`${phase}.cjs`)],process.env)
      child.once('error',reject); child.once('exit',resolve)
    })
    if(code !== 0) throw new Error(`${phase} browser checks failed (exit ${code})`)
  }
}
process.once('SIGINT',()=>{stop().finally(()=>process.exit(130))})
main().catch(async error=>{console.error(error.message);process.exitCode=1;await require('./browser-diagnostics.cjs').captureFailure(undefined,error)}).finally(stop)
