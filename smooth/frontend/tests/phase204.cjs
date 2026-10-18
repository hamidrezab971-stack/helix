// Chromium UI + real isolated backend. No production accounts or uploads.
const {chromium,expect}=require('playwright/test')
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {execFileSync}=require('node:child_process')
const h=require('./phase8.cjs')
let browser
const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true})
const row=(page,name)=>page.locator('.recent-row').filter({hasText:`@${name}`})
const actions=page=>page.locator('.conversation-actions')
async function main(){
 await h.startBackend();browser=await chromium.launch({headless:true})
 const ac=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:800}})
 const bc=await browser.newContext({viewport:{width:1280,height:800}})
 const alice=await h.newPage(ac),bob=await h.newPage(bc)
 await h.registerAndLogin(alice,h.names.alice);await h.registerAndLogin(bob,h.names.bob)
 await h.select(alice,h.names.bob);await h.send(alice,'cleared history')
 await h.select(bob,h.names.alice);await h.send(bob,'old reply')
 await h.navigate(alice,'Chats');await expect(row(alice,h.names.bob)).toBeVisible()
 // Normal taps still open. Movement and pointercancel do not trigger a menu.
 await row(alice,h.names.bob).click();await expect(alice.locator('#message-content')).toBeEnabled();await h.navigate(alice,'Chats')
 for(const ending of ['pointermove','pointercancel']){
  await row(alice,h.names.bob).dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,isPrimary:true,button:0,clientX:50,clientY:80})
  await row(alice,h.names.bob).dispatchEvent(ending,{pointerType:'touch',pointerId:1,isPrimary:true,clientX:50,clientY:110})
  await alice.waitForTimeout(550);await expect(actions(alice)).toHaveCount(0)
 }
 const cdp=await ac.newCDPSession(alice),box=await row(alice,h.names.bob).boundingBox()
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]})
 await expect(alice.getByRole('dialog',{name:'Chat actions',exact:true})).toBeVisible()
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
 await alice.getByRole('button',{name:'Delete Chat',exact:true}).click()
 await expect(alice.getByText('Delete this conversation for you?',{exact:true})).toBeVisible()
 await alice.getByRole('button',{name:'Cancel',exact:true}).click();await expect(actions(alice)).toHaveCount(0)
 await expect(row(alice,h.names.bob)).toBeVisible()
 // Explicit keyboard-accessible action and Android Back dismissal.
 await alice.getByRole('button',{name:`Chat actions for ${h.names.bob}`}).click()
 await expect(actions(alice)).toBeVisible();await alice.evaluate(()=>history.back());await expect(actions(alice)).toHaveCount(0)
 await alice.getByRole('button',{name:`Chat actions for ${h.names.bob}`}).click()
 await alice.keyboard.press('Escape');await expect(actions(alice)).toHaveCount(0)
 // Backend failure leaves the row visible and the confirmation offers retry.
 await alice.route('**/api/conversations/*',route=>route.request().method()==='DELETE'?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue())
 await alice.getByRole('button',{name:`Chat actions for ${h.names.bob}`}).click()
 await alice.getByRole('button',{name:'Delete Chat',exact:true}).click();await alice.getByRole('button',{name:'Delete chat',exact:true}).click()
 await expect(actions(alice).getByRole('alert')).toBeVisible();await expect(row(alice,h.names.bob)).toBeVisible()
 await alice.unroute('**/api/conversations/*')
 await alice.getByRole('button',{name:'Delete chat',exact:true}).dblclick()
 await expect(row(alice,h.names.bob)).toHaveCount(0);await alice.reload();await expect(row(alice,h.names.bob)).toHaveCount(0)
 await expect(bob.getByText('cleared history',{exact:true})).toBeVisible()
 const revived=await h.send(bob,'new message after clear');await expect(row(alice,h.names.bob)).toBeVisible()
 await row(alice,h.names.bob).click()
 await expect(h.rowById(alice,revived.id)).toHaveCount(1)
 await expect(h.rowById(alice,revived.id).getByText('new message after clear',{exact:true})).toBeVisible()
 await expect(alice.locator('.message-list').getByText('cleared history',{exact:true})).toHaveCount(0)
 await h.navigate(alice,'Chats')
 // Right click and keyboard contextmenu alternative on desktop.
 await row(bob,h.names.alice).click({button:'right'});await expect(actions(bob)).toBeVisible();await bob.keyboard.press('Escape')
 await row(bob,h.names.alice).focus();await bob.keyboard.press('Shift+F10');await expect(actions(bob)).toBeVisible();await bob.keyboard.press('Escape')
 // Actual crop -> multipart -> stored square -> avatar invalidation.
 let uploads=0;alice.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/profiles/me/photos'))uploads++})
 await nav(alice,'Profile').click();await alice.getByRole('button',{name:'Manage photos',exact:true}).click()
 const input=alice.getByLabel('Choose profile photo')
 for(const format of ['JPEG','PNG','WEBP']){
  const filename=path.join(h.temporary,`phase204-${format.toLowerCase()}`)
  execFileSync(path.join(h.backendDirectory,'.venv/bin/python'),['-c','from PIL import Image;import sys;exif=Image.Exif();exif[274]=6;exif[270]="private";Image.new("RGB",(1800,1200),"coral").save(sys.argv[1],sys.argv[2],exif=exif)',filename,format])
  await input.setInputFiles(filename);await expect(alice.getByRole('heading',{name:'Choose your crop'})).toBeVisible()
  const count=uploads
  if(format==='JPEG'){
   await alice.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(uploads,count)
   await input.setInputFiles(filename);await expect(alice.getByRole('heading',{name:'Choose your crop'})).toBeVisible()
   await alice.route('**/api/profiles/me/photos',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}))
   await alice.getByRole('button',{name:'Save photo',exact:true}).click();await expect(alice.locator('.crop-dialog [role=alert]')).toBeVisible()
   await alice.unroute('**/api/profiles/me/photos')
  }
  await alice.getByRole('button',{name:'Save photo',exact:true}).dblclick()
  await expect(alice.getByRole('heading',{name:'Choose your crop'})).toHaveCount(0)
  assert.equal(uploads,count+(format==='JPEG'?2:1))
 }
 // Simulate the precise browser failure, then retry the very same selection.
 await alice.evaluate(()=>{
  window.originalFileReader=FileReader
  window.FileReader=class extends FileReader{readAsArrayBuffer(){queueMicrotask(()=>this.onerror?.(new Event('error')))}}
 })
 const same=path.join(h.temporary,'phase204-png')
 await input.setInputFiles(same);await expect(alice.getByRole('alert')).toContainText('select it again')
 await expect(alice.getByText('The requested file could not be read',{exact:false})).toHaveCount(0)
 await alice.evaluate(()=>{window.FileReader=window.originalFileReader})
 await input.setInputFiles(same);await expect(alice.getByRole('heading',{name:'Choose your crop'})).toBeVisible()
 await alice.getByRole('button',{name:'Cancel',exact:true}).click()
 // Closing the profile during a pending selection aborts its FileReader.
 await alice.evaluate(()=>{
  window.FileReader=class extends window.originalFileReader{
   readAsArrayBuffer(){window.delayedProfileReader=this}
   abort(){this.wasAborted=true;super.abort()}
  }
 })
 await input.setInputFiles(same)
 await expect(alice.getByRole('button',{name:'Opening photo…',exact:true})).toBeVisible()
 await alice.getByRole('button',{name:'Close profile',exact:true}).click()
 await expect.poll(()=>alice.evaluate(()=>window.delayedProfileReader?.wasAborted)).toBe(true)
 await expect(alice.getByRole('heading',{name:'Choose your crop'})).toHaveCount(0)
 await alice.evaluate(()=>{window.FileReader=window.originalFileReader})
 await h.navigate(bob,'Contacts');await bob.locator('#user-search').fill(h.names.alice)
 await expect(bob.locator('.identity-row').filter({hasText:`@${h.names.alice}`}).locator('.chat-avatar img')).toBeVisible()
 await h.navigate(bob,'Chats');await expect(row(bob,h.names.alice).locator('..').locator('.chat-avatar img')).toBeVisible()
 await row(bob,h.names.alice).click();await expect(bob.locator('.chat-header .chat-avatar img')).toBeVisible()
 await alice.emulateMedia({reducedMotion:'reduce'})
 assert.deepEqual(h.errors,[])
 console.log('PASS Phase 20.4 Chromium: tap/long-press/movement/cancel/Back/Escape/keyboard/right-click, confirm/retry/private deletion/refresh/new messages, JPEG/PNG/WebP crop+multipart/retry/avatars')
}
main().catch(async error=>{console.error(error);process.exitCode=1;await h.captureFailure(browser,error)}).finally(async()=>{await browser?.close();await h.stopBackend();fs.rmSync(h.temporary,{recursive:true,force:true})})
