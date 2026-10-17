import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCropImage, exportCrop, cropGeometry, cropErrorMessage, readSelectedImage } from '../src/utils/crop.js'
import { conversationGesture } from '../src/utils/conversationGesture.js'

function png(width=600,height=900) {
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer)
  bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12)
  view.setUint32(16,width);view.setUint32(20,height)
  return new Blob([bytes],{type:'image/png'})
}
function browserHarness() {
  const created=[],revoked=[],decoded=[],draws=[],readers=[]
  const saved=Object.fromEntries(['FileReader','Image','document'].map(k=>[k,globalThis[k]]))
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL
  let releaseRead,holdRead=false,failRead=false,failDecode=false,nullBlob=false
  class Reader {
    constructor(){readers.push(this)}
    readAsArrayBuffer(file){
      const finish=async()=>{if(this.canceled)return;if(failRead){this.error=new DOMException('raw private provider error','NotReadableError');this.onerror();return}this.result=await file.arrayBuffer();if(!this.canceled)this.onload()}
      if(holdRead)releaseRead=finish;else queueMicrotask(finish)
    }
    abort(){this.canceled=true;this.onabort?.()}
  }
  globalThis.FileReader=Reader
  globalThis.Image=class {
    naturalWidth=600;naturalHeight=900
    set src(value){this.value=value;if(value)queueMicrotask(()=>{decoded.push(value);if(failDecode)this.onerror?.();else this.onload?.()})}
    get src(){return this.value}
  }
  globalThis.document={createElement(){return {
    width:0,height:0,
    getContext(){return {drawImage(...args){draws.push(args)}}},
    toBlob(callback,type){queueMicrotask(()=>callback(nullBlob?null:new Blob(['encoded'],{type})))},
  }}}
  URL.createObjectURL=blob=>{const url=`blob:owned-${created.length}`;created.push({blob,url});return url}
  URL.revokeObjectURL=url=>revoked.push(url)
  return {created,revoked,decoded,draws,readers,
    hold(){holdRead=true},release:()=>releaseRead(),fail(){failRead=true},decodeFailure(){failDecode=true},encodeFailure(){nullBlob=true},
    restore(){for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}URL.createObjectURL=create;URL.revokeObjectURL=revoke},
  }
}

test('Selected bytes are owned before input reset; original provider is read once and never decoded',async()=>{
  const h=browserHarness()
  try {
    const original=png();let reads=0,reset=false
    original.arrayBuffer=async()=>{reads++;assert.equal(reset,false);return Blob.prototype.arrayBuffer.call(original)}
    const image=await prepareCropImage(original,{onRead(){reset=true}})
    assert.equal(reset,true);assert.equal(reads,1)
    assert.notEqual(h.created[0].blob,original)
    assert.equal(h.created[0].blob.size,original.size)
    assert.deepEqual(h.revoked,[h.created[0].url])
    assert.equal(h.revoked.includes(image.url),false)
    const output=await exportCrop(image,cropGeometry(image.width,image.height,280))
    assert.equal(output.type,'image/webp')
    assert.deepEqual(h.draws.at(-1).slice(-4),[0,0,512,512])
    image.dispose();image.dispose()
    assert.deepEqual(h.revoked,h.created.map(v=>v.url))
  } finally {h.restore()}
})
test('Input remains selected for the entire asynchronous provider read',async()=>{
  const h=browserHarness()
  try {
    h.hold();let reset=false
    const pending=prepareCropImage(png(),{onRead(){reset=true}})
    assert.equal(reset,false);assert.equal(h.created.length,0)
    await h.release();const image=await pending
    assert.equal(reset,true);image.dispose()
  } finally {h.restore()}
})
test('Provider read errors have a friendly recovery message and allocate no object URLs',async()=>{
  const h=browserHarness()
  try {h.fail();await assert.rejects(prepareCropImage(png()),error=>{
    assert.equal(error.stage,'read');assert.match(cropErrorMessage(error),/select it again/);assert.doesNotMatch(cropErrorMessage(error),/raw private/);return true
  });assert.equal(h.created.length,0)}finally{h.restore()}
})
test('Unmount while reading aborts the reader and prevents late decode or URLs',async()=>{
  const h=browserHarness()
  try {
    h.hold();const controller=new AbortController()
    const pending=prepareCropImage(png(),{signal:controller.signal})
    controller.abort();await assert.rejects(pending,{name:'AbortError'})
    await h.release();assert.equal(h.readers[0].canceled,true);assert.equal(h.created.length,0)
  }finally{h.restore()}
})
test('Decode and encode failure revoke their owned source without leaking URLs',async()=>{
  for(const failure of ['decodeFailure','encodeFailure']){
    const h=browserHarness()
    try {h[failure]();await assert.rejects(prepareCropImage(png()));assert.deepEqual(h.revoked,h.created.map(v=>v.url))}finally{h.restore()}
  }
})
test('Cancel and repeated selection retain independent lifetimes',async()=>{
  const h=browserHarness()
  try {
    const file=png(),a=await prepareCropImage(file);a.dispose()
    const b=await prepareCropImage(file)
    assert.notEqual(a.url,b.url);assert.equal(h.revoked.includes(b.url),false)
    await exportCrop(b,cropGeometry(b.width,b.height,320,2));b.dispose()
    assert.equal(new Set(h.revoked).size,h.created.length)
  }finally{h.restore()}
})
test('Unknown technical exceptions never become user-facing primary errors',()=>{
  assert.doesNotMatch(cropErrorMessage(new Error('The requested file could not be read /private/handle')),/requested file|private/)
})
test('Missing FileReader uses the bounded Blob API without requiring createImageBitmap or Image.decode',async()=>{
  const saved=globalThis.FileReader;delete globalThis.FileReader
  try {assert.equal((await readSelectedImage(png())).byteLength,24)}finally{if(saved)globalThis.FileReader=saved}
})

function gestureHarness(){
  let fire,opened=0,canceled=0
  const element={}
  const event={isPrimary:true,button:0,pointerType:'touch',pointerId:1,clientX:20,clientY:20,currentTarget:element,preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true}}
  const gesture=conversationGesture(target=>{assert.equal(target,element);opened++},{schedule(fn,delay){assert.equal(delay,480);fire=fn;return 1},unschedule(){fire=null;canceled++}})
  return {gesture,event,fire:()=>fire?.(),opened:()=>opened,canceled:()=>canceled}
}
test('Long press opens once and consumes the following synthetic tap',()=>{
  const h=gestureHarness();h.gesture.down(h.event);h.fire();assert.equal(h.opened(),1)
  assert.equal(h.gesture.click(h.event),false);assert.equal(h.event.prevented,true);assert.equal(h.event.stopped,true)
})
test('Normal tap retains tap-to-open behavior',()=>{
  const h=gestureHarness();h.gesture.down(h.event);h.gesture.up();h.fire();assert.equal(h.opened(),0);assert.equal(h.gesture.click(h.event),true)
})
test('Scrolling movement cancels long press and suppresses accidental navigation',()=>{
  const h=gestureHarness();h.gesture.down(h.event);h.gesture.move({...h.event,clientY:31});h.fire()
  assert.equal(h.opened(),0);assert.equal(h.gesture.click(h.event),false)
})
test('Pointer cancellation, scroll, second finger, visibility and unmount cancel pending menus',()=>{
  for(const method of ['interrupt','cancel']){const h=gestureHarness();h.gesture.down(h.event);h.gesture[method]();h.fire();assert.equal(h.opened(),0)}
})
test('Right-click works repeatedly and native contextmenu after long press does not duplicate',()=>{
  const h=gestureHarness();h.gesture.down(h.event);h.fire();h.gesture.context(h.event);assert.equal(h.opened(),1)
  h.gesture.down({...h.event,pointerType:'mouse',button:2});h.gesture.context(h.event);assert.equal(h.opened(),2)
  h.gesture.down({...h.event,pointerType:'mouse',button:2});h.gesture.context(h.event);assert.equal(h.opened(),3)
})
