// Real Chromium + fetch + WebSocket through a loopback rehearsal Nginx.
// Run with NODE_PATH pointing to a separately pinned Playwright installation.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { pbkdf2Sync } = require('node:crypto')
const fs = require('node:fs')
const base = process.env.HELIX_REHEARSAL_ORIGIN || 'http://127.0.0.1:18443'
assert.equal(new URL(base).hostname, '127.0.0.1', 'Only loopback rehearsal is permitted')
assert.equal(process.env.HELIX_DISPOSABLE_DATA, 'yes', 'Explicit disposable-copy acknowledgement required')
const suffix = Date.now().toString(36)
const password = 'isolated-rehearsal-password-'+suffix
async function main() {
 const browser=await chromium.launch({headless:true})
 try {
  const context=await browser.newContext()
  const page=await context.newPage()
  await page.goto(base)
  assert.match(await page.content(), /<div id="root"/)
  // Solve the actual server-issued proof of work; no challenge bypass.
  async function protectedPost(path, username) {
   const purpose=path.endsWith('/register')?'register':'login'
   const challenge=await (await context.request.get(base+'/api/auth/challenge?purpose='+purpose)).json()
   const parameters=challenge.parameters
   assert.equal(parameters.algorithm,'PBKDF2/SHA-256')
   assert(parameters.cost<=10000)
   let solution
   for(let counter=0;counter<100000;counter++) {
    const suffix=Buffer.alloc(4);suffix.writeUInt32BE(counter)
    const derivedKey=pbkdf2Sync(Buffer.concat([Buffer.from(parameters.nonce,'hex'),suffix]),Buffer.from(parameters.salt,'hex'),parameters.cost,parameters.keyLength,'sha256').toString('hex')
    if(derivedKey.startsWith(parameters.keyPrefix)) {solution={counter,derivedKey};break}
   }
   assert(solution,'Actual CAPTCHA must be solvable')
   const altcha=Buffer.from(JSON.stringify({challenge,solution})).toString('base64')
   return context.request.post(base+path,{data:{username,password,altcha}})
  }
  const accounts=[]
  for(const role of ['a','b']) {
   const username='infra_'+role+'_'+suffix
   const r=await protectedPost('/api/auth/register',username); assert.equal(r.status(),201)
   const user=await r.json()
   const login=await protectedPost('/api/auth/login',username); assert.equal(login.status(),200)
   accounts.push({...user,token:(await login.json()).access_token})
  }
  const [alice,bob]=accounts
  const headers={Authorization:'Bearer '+alice.token}
  const c=await context.request.post(base+'/api/conversations/with/'+bob.id,{headers})
  assert.equal(c.status(),201)
  const conversation=await c.json(), path=base+'/api/conversations/'+conversation.id+'/messages'
  await page.evaluate(async ({base,token})=>{
   window.observed=[]
   window.connection=new WebSocket(base.replace('http','ws')+'/ws')
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('WebSocket auth timeout')),8000)
    window.connection.onopen=()=>window.connection.send(JSON.stringify({type:'auth',token}))
    window.connection.onmessage=e=>{
     const data=JSON.parse(e.data);window.observed.push(data)
     if(data.type==='presence:snapshot') {clearTimeout(timer);resolve()}
    }
    window.connection.onerror=()=>reject(new Error('WebSocket transport failed'))
   })
  },{base,token:bob.token})
  const sent=await context.request.post(path,{headers,data:{content:'Isolated infrastructure rehearsal '+suffix}})
  assert.equal(sent.status(),201)
  const message=await sent.json()
  await page.waitForFunction(id=>window.observed.some(e=>e.type==='message:new'&&e.data.id===id),message.id)
  // A real PNG fixture supplied by the operator, never a user upload.
  const image=fs.readFileSync(process.env.HELIX_QA_IMAGE)
  const uploaded=await context.request.post(path+'/image',{headers,multipart:{file:{name:'synthetic.png',mimeType:'image/png',buffer:image}}})
  assert.equal(uploaded.status(),201)
  const photo=await uploaded.json()
  await page.waitForFunction(id=>window.observed.some(e=>e.type==='message:new'&&e.data.id===id),photo.id)
  const retrieved=await context.request.get(base+'/api/attachments/'+photo.attachment.id+'/content',{headers:{Authorization:'Bearer '+bob.token}})
  assert.equal(retrieved.status(),200)
  assert.deepEqual(await retrieved.body(),image)
  const rejected=await context.request.post(path+'/image',{headers,multipart:{file:{name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('invalid image')}}})
  assert.equal(rejected.status(),422)
  const history=await (await context.request.get(path,{headers})).json()
  assert(history.some(x=>x.id===message.id));assert(history.some(x=>x.id===photo.id))
  assert.equal((await context.request.get(base+'/internal/metrics')).status(),404)
  await page.evaluate(()=>window.connection.close())
  console.log(JSON.stringify({captcha:true,login:true,nginxWebSocket:true,message:true,imageUploadRetrieval:true,history:true,metricsPrivate:true}))
 } finally {await browser.close()}
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
