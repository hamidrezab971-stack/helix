// Start Vite once, then run the isolated backend/browser regressions serially.
const { spawn } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname,'..')
const vite = spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1'],{cwd:root,stdio:'inherit'})
let child
async function stop() {
  if(child && child.exitCode === null) child.kill('SIGTERM')
  if(vite.exitCode === null) {
    const done = new Promise(resolve => vite.once('exit',resolve)); vite.kill('SIGTERM'); await done
  }
}
async function main() {
  let ready = false
  for(let i=0;i<100;i++) {
    if(vite.exitCode !== null) throw new Error('Vite failed to start; use Node >=22.12 and npm ci, with port 5173 free.')
    try { if((await fetch('http://127.0.0.1:5173')).ok) {ready=true;break} } catch {}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(!ready) throw new Error('Frontend startup timed out')
  const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['phase8','phase17','phase18']
  for(const phase of phases) {
    if(!['phase8','phase17','phase18'].includes(phase)) throw new Error('Unknown browser regression phase')
    const code = await new Promise((resolve,reject) => {
      child=spawn(process.execPath,[path.join(__dirname,`${phase}.cjs`)],{cwd:root,stdio:'inherit',env:process.env})
      child.once('error',reject); child.once('exit',resolve)
    })
    if(code !== 0) throw new Error(`${phase} browser checks failed (exit ${code})`)
  }
}
process.once('SIGINT',()=>{stop().finally(()=>process.exit(130))})
main().catch(error=>{console.error(error.message);process.exitCode=1}).finally(stop)
