// Real Chromium + authenticated isolated FastAPI, SQLite and private storage.
// Fault injection is limited to failures; successful uploads hit the real API.
const { chromium, expect } = require('playwright/test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./phase8.cjs')
let browser
const photo = async (page, selector) => {
 const element=page.locator(selector).last()
 await expect(element).toBeVisible()
 await expect.poll(()=>element.evaluate(img=>img.complete && img.naturalWidth>0)).toBe(true)
 return element
}
async function main(){
 await h.startBackend();browser=await chromium.launch({headless:true})
 const ac=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:800}})
 const bc=await browser.newContext({viewport:{width:1280,height:800}})
 const alice=await h.newPage(ac),bob=await h.newPage(bc)
 await h.registerAndLogin(alice,h.names.alice);await h.registerAndLogin(bob,h.names.bob)
 await h.select(alice,h.names.bob);await h.select(bob,h.names.alice)
 const files={}
 for(const format of ['JPEG','PNG','WEBP']){
  const filename=path.join(h.temporary,`gallery.${format==='JPEG'?'jpg':format.toLowerCase()}`)
  execFileSync(path.join(h.backendDirectory,'.venv/bin/python'),['-c','from PIL import Image;import sys;exif=Image.Exif();exif[274]=6;exif[270]="synthetic QA metadata";Image.new("RGB",(640,360),"coral").save(sys.argv[1],sys.argv[2],exif=exif)',filename,format])
  files[format]=filename
 }
 let posts=0
 const sanitized=[]
 alice.on('request',request=>{
  if(request.method()==='POST'&&request.url().endsWith('/messages/image')){
   posts++;const headers=request.headers()
   assert.match(headers['content-type'],/^multipart\/form-data; boundary=/)
   assert.match(headers.authorization,/^Bearer .+/)
  }
 })
 alice.on('response',response=>{if(response.url().endsWith('/messages/image'))sanitized.push({operation:'image_upload',status:response.status()})})
 const input=alice.getByLabel('Choose image')
 // Delayed provider bytes must be read before the picker is cleared.
 await alice.evaluate(()=>{
  window.chatReader=FileReader
  window.FileReader=class extends FileReader{readAsArrayBuffer(file){window.releaseChatRead=()=>super.readAsArrayBuffer(file)}}
 })
 await input.setInputFiles(files.JPEG)
 await expect(alice.getByText('Preparing photo…',{exact:true})).toBeVisible()
 await expect(alice.getByRole('button',{name:'Send',exact:true})).toBeDisabled()
 assert.equal(await input.evaluate(element=>element.files.length),1)
 await alice.evaluate(()=>window.releaseChatRead())
 await photo(alice,'#composer-image-preview')
 assert.equal(await input.evaluate(element=>element.files.length),0)
 await alice.evaluate(()=>{window.FileReader=window.chatReader})
 await alice.getByRole('button',{name:'Remove image',exact:true}).click()
 await expect(alice.locator('#composer-image-preview')).toHaveCount(0)
 for(const format of ['JPEG','PNG','WEBP']){
  const count=posts
  await input.setInputFiles(files[format]);await photo(alice,'#composer-image-preview')
  const responsePromise=alice.waitForResponse(r=>r.url().endsWith('/messages/image')&&r.status()===201)
  // Two submit events in the same JS task exercise the synchronous duplicate guard.
  await alice.locator('form[aria-label="Send message"]').evaluate(form=>{form.requestSubmit();form.requestSubmit()})
  const message=await (await responsePromise).json()
  assert.equal(posts,count+1)
  await photo(alice,`[data-attachment-id="${message.attachment.id}"]`)
  await photo(bob,`[data-attachment-id="${message.attachment.id}"]`)
  await alice.reload();await photo(alice,`[data-attachment-id="${message.attachment.id}"]`)
  await alice.evaluate(()=>window.realtimeTest.socket.close())
  await expect.poll(()=>alice.evaluate(()=>window.realtimeTest.authenticated)).toBeGreaterThan(1)
  await photo(alice,`[data-attachment-id="${message.attachment.id}"]`)
 }
 // Pending preview, server rejection, retry of the same owned bytes and UUID.
 let release,mode='hold',keys=[]
 await alice.route('**/api/conversations/*/messages/image',async route=>{
  const body=route.request().postDataBuffer().toString('latin1')
  const key=body.match(/name="client_message_id"\r\n\r\n([^\r]+)/)?.[1];assert.ok(key);keys.push(key)
  if(mode==='hold'){await new Promise(resolve=>{release=resolve});await route.fulfill({status:503,contentType:'application/json',body:'{}'})}
  else await route.continue()
 })
 await input.setInputFiles(files.PNG);await photo(alice,'#composer-image-preview')
 await alice.getByRole('button',{name:'Send',exact:true}).click()
 await photo(alice,'.pending-photo')
 await expect.poll(()=>Boolean(release)).toBe(true);release()
 await expect(alice.locator('.pending-message')).toHaveAttribute('data-state','failed')
 await expect(alice.locator('.pending-error')).toContainText('server could not save')
 await photo(alice,'.pending-photo');mode='continue'
 await alice.getByRole('button',{name:'Retry message',exact:true}).click()
 await expect(alice.locator('.pending-message')).toHaveCount(0)
 assert.equal(keys.length,2);assert.equal(keys[0],keys[1])
 await alice.unroute('**/api/conversations/*/messages/image')
 // Offline failure retains the already prepared Blob and succeeds without a picker.
 await input.setInputFiles(files.WEBP);await photo(alice,'#composer-image-preview')
 await ac.setOffline(true);await alice.getByRole('button',{name:'Send',exact:true}).click()
 await expect(alice.locator('.pending-message')).toHaveAttribute('data-state','failed')
 await expect(alice.locator('.pending-error')).toContainText('offline')
 await photo(alice,'.pending-photo');await ac.setOffline(false)
 await alice.getByRole('button',{name:'Retry message',exact:true}).click()
 await expect(alice.locator('.pending-message')).toHaveCount(0)
 // Actual input read failure, recovery, and removal clean up all local preview URLs.
 await alice.evaluate(()=>{window.FileReader=class extends window.chatReader{readAsArrayBuffer(){queueMicrotask(()=>this.onerror?.(new Event('error')))}}})
 await input.setInputFiles(files.JPEG)
 await expect(alice.locator('.chat-composer [role="alert"]')).toContainText('select it again')
 await expect(alice.locator('#composer-image-preview')).toHaveCount(0)
 await alice.evaluate(()=>{window.FileReader=window.chatReader})
 await input.setInputFiles({name:'invalid.jpg',mimeType:'image/jpeg',buffer:Buffer.from('not a photo')})
 await expect(alice.locator('.chat-composer [role="alert"]')).toContainText('valid')
 await input.setInputFiles({name:'oversized.png',mimeType:'image/png',buffer:Buffer.alloc(8*1024*1024+1)})
 await expect(alice.locator('.chat-composer [role="alert"]')).toContainText('8 MB')
 const urls=await alice.evaluate(()=>[...window.imageUrls.created])
 await input.setInputFiles(files.PNG);const selected=await photo(alice,'#composer-image-preview');const selectedUrl=await selected.getAttribute('src')
 await alice.getByRole('button',{name:'Remove image',exact:true}).click()
 await expect(alice.locator('#composer-image-preview')).toHaveCount(0)
 await expect.poll(()=>alice.evaluate(url=>window.imageUrls.revoked.includes(url),selectedUrl)).toBe(true)
 assert.ok(urls.length>0)
 // Abort transport before publication, then dismiss the cancelled local intent.
 await alice.route('**/api/conversations/*/messages/image',route=>new Promise(resolve=>{
  const timer=setTimeout(()=>{route.abort().catch(()=>{});resolve()},800)
  route.request().response().catch(()=>{}).finally(()=>{clearTimeout(timer);resolve()})
 }))
 await input.setInputFiles(files.PNG);await photo(alice,'#composer-image-preview')
 await alice.getByRole('button',{name:'Send',exact:true}).click();await photo(alice,'.pending-photo')
 await alice.getByRole('button',{name:'Cancel send',exact:true}).click()
 await expect(alice.locator('.pending-message')).toHaveAttribute('data-state','cancelled')
 await alice.getByRole('button',{name:'Dismiss message',exact:true}).click();await expect(alice.locator('.pending-message')).toHaveCount(0)
 await alice.unroute('**/api/conversations/*/messages/image')
 // Mobile layout, focus and reduced motion use the real computed browser styles.
 for(const width of [360,390,430]){
  await alice.setViewportSize({width,height:640});await input.setInputFiles(files.JPEG);await photo(alice,'#composer-image-preview')
  assert.equal(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  const send=await alice.getByRole('button',{name:'Send',exact:true}).boundingBox();assert.ok(send.width>=44&&send.height>=44)
  await alice.getByRole('button',{name:'Remove image',exact:true}).click()
 }
 assert.equal(await alice.locator('.helix-icon').first().evaluate(icon=>getComputedStyle(icon).pointerEvents),'none')
 await alice.emulateMedia({reducedMotion:'reduce'})
 assert.equal(await alice.getByRole('button',{name:'Send',exact:true}).evaluate(button=>getComputedStyle(button).transitionDuration),'0s')
 await alice.getByRole('button',{name:'Image',exact:true}).focus();await expect(alice.getByRole('button',{name:'Image',exact:true})).toBeFocused()
 assert.deepEqual(h.errors,[])
 console.log(JSON.stringify({phase:'21.1',status:'passed',sanitized_network:sanitized,physical_android_tested:false}))
}
main().catch(async error=>{console.error(error);process.exitCode=1;await h.captureFailure(browser,error)}).finally(async()=>{await browser?.close();await h.stopBackend();fs.rmSync(h.temporary,{recursive:true,force:true})})
