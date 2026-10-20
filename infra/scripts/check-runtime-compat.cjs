// Authenticate accounts created only in the disposable copy, across old/new runtimes.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pbkdf2Sync } = require('node:crypto')
const base = process.env.HELIX_REHEARSAL_ORIGIN || 'http://127.0.0.1:18443'
assert.equal(new URL(base).hostname, '127.0.0.1')
assert.equal(process.env.HELIX_DISPOSABLE_DATA, 'yes')
const fixture=JSON.parse(fs.readFileSync(process.env.HELIX_REHEARSAL_ACCOUNTS_FILE,'utf8'))
async function main() {
 const browser=await chromium.launch({headless:true})
 try {
  const context=await browser.newContext(), page=await context.newPage()
  await page.goto(base)
  const accounts=[]
  for(const account of fixture.accounts) {
   const challenge=await (await context.request.get(base+'/api/auth/challenge?purpose=login')).json(), p=challenge.parameters
   assert.equal(p.algorithm,'PBKDF2/SHA-256');assert(p.cost<=10000)
   let solution
   for(let counter=0;counter<100000;counter++) {
    const n=Buffer.alloc(4);n.writeUInt32BE(counter)
    const derivedKey=pbkdf2Sync(Buffer.concat([Buffer.from(p.nonce,'hex'),n]),Buffer.from(p.salt,'hex'),p.cost,p.keyLength,'sha256').toString('hex')
    if(derivedKey.startsWith(p.keyPrefix)){solution={counter,derivedKey};break}
   }
   assert(solution)
   const altcha=Buffer.from(JSON.stringify({challenge,solution})).toString('base64')
   const r=await context.request.post(base+'/api/auth/login',{data:{username:account.username,password:account.password,altcha}})
   assert.equal(r.status(),200)
   accounts.push({...account,token:(await r.json()).access_token})
  }
  const [alice,bob]=accounts, headers={Authorization:'Bearer '+alice.token}
  await page.evaluate(async ({base,token})=>{
   window.observed=[];window.connection=new WebSocket(base.replace('http','ws')+'/ws')
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('WebSocket timeout')),8000)
    window.connection.onopen=()=>window.connection.send(JSON.stringify({type:'auth',token}))
    window.connection.onmessage=e=>{const d=JSON.parse(e.data);window.observed.push(d);if(d.type==='presence:snapshot'){clearTimeout(timer);resolve()}}
    window.connection.onerror=()=>reject(new Error('WebSocket failed'))
   })
  },{base,token:bob.token})
  const path=base+'/api/conversations/'+fixture.conversationId+'/messages'
  const r=await context.request.post(path,{headers,data:{content:'Disposable runtime compatibility '+Date.now()}})
  assert.equal(r.status(),201);const message=await r.json()
  await page.waitForFunction(id=>window.observed.some(x=>x.type==='message:new'&&x.data.id===id),message.id)
  const history=await (await context.request.get(path,{headers})).json()
  assert(history.some(x=>x.id===fixture.messageId));assert(history.some(x=>x.id===message.id))
  const media=await context.request.get(base+'/api/attachments/'+fixture.attachmentId+'/content',{headers})
  assert.equal(media.status(),200);assert.deepEqual(await media.body(),fs.readFileSync(fixture.imagePath))
  await page.evaluate(()=>window.connection.close())
  console.log(JSON.stringify({existingSyntheticAccountLogin:true,captcha:true,websocket:true,presence:true,newWrite:true,priorHistory:true,priorMedia:true}))
 } finally {await browser.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
