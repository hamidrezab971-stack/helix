import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareChatImage, chatImageError, MAX_CHAT_IMAGE_BYTES } from '../src/utils/chatImage.js'
import { request, sendImage } from '../src/services/api.js'
import { uploadMultipart } from '../src/services/upload.js'

function header(type='image/png',width=600,height=900) {
 if(type==='image/jpeg')return Uint8Array.of(255,216,255,192,0,8,8,height>>8,height&255,width>>8,width&255,1)
 const bytes=new Uint8Array(type==='image/png'?24:30),view=new DataView(bytes.buffer)
 if(type==='image/png'){bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);view.setUint32(16,width);view.setUint32(20,height)}
 else{bytes.set(Buffer.from('RIFF'));view.setUint32(4,22,true);bytes.set(Buffer.from('WEBPVP8X'),8);view.setUint32(16,10,true);bytes[24]=(width-1)&255;bytes[25]=(width-1)>>8;bytes[27]=(height-1)&255;bytes[28]=(height-1)>>8}
 return bytes
}
function harness(){
 const saved=Object.fromEntries(['FileReader','Image'].map(k=>[k,globalThis[k]])),create=URL.createObjectURL,revoke=URL.revokeObjectURL
 const urls=new Map(),revoked=[],readers=[];let failRead=false,failDecode=false,release,hold=false
 globalThis.FileReader=class{
  constructor(){readers.push(this)}
  readAsArrayBuffer(file){const run=async()=>{if(this.aborted)return;try{if(failRead)throw new Error('private handle');this.result=await file.arrayBuffer();if(!this.aborted)this.onload()}catch{if(!this.aborted)this.onerror?.()}};if(hold)release=run;else queueMicrotask(run)}
  abort(){this.aborted=true;this.onabort?.()}
 }
 globalThis.Image=class{naturalWidth=600;naturalHeight=900;set src(value){if(value)queueMicrotask(()=>failDecode?this.onerror?.():this.onload?.())}}
 URL.createObjectURL=blob=>{const url=`blob:chat-${urls.size}`;urls.set(url,blob);return url};URL.revokeObjectURL=url=>revoked.push(url)
 return{urls,revoked,readers,failRead:()=>{failRead=true},failDecode:()=>{failDecode=true},hold:()=>{hold=true},release:()=>release(),restore(){for(const[k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}URL.createObjectURL=create;URL.revokeObjectURL=revoke}}
}
for(const type of ['image/jpeg','image/png','image/webp'])test(`Owned ${type} bytes survive picker reset and retry`,async()=>{
 const h=harness();let reset=false,reads=0
 try{const bytes=header(type),source={name:'Gallery photo',type,size:bytes.byteLength,arrayBuffer:async()=>{reads++;assert.equal(reset,false);return bytes.buffer}}
 const image=await prepareChatImage(source,{onRead(){reset=true}});assert.equal(reads,1);assert.equal(reset,true);assert.equal(image.blob.type,type)
 assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()),bytes);assert.equal(image.width,600);assert.equal(image.height,900)
 assert.ok([...h.urls.values()].every(blob=>blob!==source));assert.deepEqual(h.revoked,[...h.urls.keys()]);source.arrayBuffer=()=>{throw new Error('provider released')};assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()),bytes)
 }finally{h.restore()}
})
test('Delayed provider read retains selection until all bytes are owned',async()=>{const h=harness();h.hold();let reset=false;try{const pending=prepareChatImage(new Blob([header()],{type:'image/png'}),{onRead(){reset=true}});assert.equal(reset,false);assert.equal(h.urls.size,0);await h.release();await pending;assert.equal(reset,true)}finally{h.restore()}})
test('Unreadable provider produces no broken preview and no private exception',async()=>{const h=harness();h.failRead();try{await assert.rejects(prepareChatImage(new Blob([header()],{type:'image/png'})),e=>{assert.match(chatImageError(e),/select it again/);assert.doesNotMatch(chatImageError(e),/private/);return true});assert.equal(h.urls.size,0)}finally{h.restore()}})
test('Cancel aborts reading and prevents late URLs',async()=>{const h=harness();h.hold();const c=new AbortController();try{const pending=prepareChatImage(new Blob([header()],{type:'image/png'}),{signal:c.signal});c.abort();await assert.rejects(pending,{name:'AbortError'});await h.release();assert.equal(h.readers[0].aborted,true);assert.equal(h.urls.size,0)}finally{h.restore()}})
test('Invalid MIME, empty, oversized, spoofed and unsafe dimensions fail before decode',async()=>{const h=harness();try{for(const file of [{type:'image/gif',size:1},{type:'image/png',size:0},{type:'image/png',size:MAX_CHAT_IMAGE_BYTES+1},new Blob([header('image/png',6000,6000)],{type:'image/png'}),new Blob([header()],{type:'image/jpeg'}),new Blob(['invalid'],{type:'image/png'})])await assert.rejects(prepareChatImage(file));assert.equal(h.urls.size,0)}finally{h.restore()}})
test('Unknown Android MIME is detected from bounded content',async()=>{const h=harness();try{assert.equal((await prepareChatImage(new Blob([header()],{type:'application/octet-stream'}))).blob.type,'image/png')}finally{h.restore()}})
test('Decode failures revoke temporary owned URLs',async()=>{const h=harness();h.failDecode();try{await assert.rejects(prepareChatImage(new Blob([header()],{type:'image/png'})));assert.deepEqual(h.revoked,[...h.urls.keys()])}finally{h.restore()}})
test('Multipart retains bytes, bearer auth and filename without manual boundary',async()=>{
 const saved=globalThis.fetch
 try{globalThis.fetch=async(url,options)=>{assert.equal(url,'/api/conversations/7/messages/image');assert.equal(options.headers.Authorization,'Bearer qa-only');assert.equal(options.headers['Content-Type'],undefined);assert.ok(options.body instanceof FormData);assert.equal(options.body.get('file').name,'Gallery.png');assert.equal(options.body.get('caption'),'caption');assert.equal(options.body.get('client_message_id'),'qa-uuid');assert.deepEqual(new Uint8Array(await options.body.get('file').arrayBuffer()),header());return new Response(JSON.stringify({id:1,sender_id:1,conversation_id:7,content:'caption',created_at:'2026-10-19T12:00:00Z',edited_at:null,delivered_at:null,read_at:null,attachment:null,reply_to:null,reactions:[],client_message_id:null}),{status:201})};await sendImage('qa-only',7,new Blob([header()],{type:'image/png'}),'caption',undefined,null,'qa-uuid',{filename:'Gallery.png'})}finally{globalThis.fetch=saved}
})
test('HTML proxy errors retain HTTP-specific upload recovery messages',async()=>{const saved=globalThis.fetch;try{for(const[status,text]of [[401,/sign-in/],[403,/access/],[413,/8 MB/],[415,/valid/],[422,/valid/],[500,/server could not save/],[503,/server could not save/]]){globalThis.fetch=async()=>new Response('<html>proxy</html>',{status});await assert.rejects(request('/api/conversations/1/messages/image',{body:new FormData()}),e=>{assert.equal(e.status,status);assert.match(e.displayMessage,text);assert.doesNotMatch(e.displayMessage,/Unable to connect/);return true})}}finally{globalThis.fetch=saved}})
test('Offline, interrupted upload and unreadable file errors differ',async()=>{const saved=globalThis.fetch,nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');try{for(const[online,name,text]of [[true,'TypeError',/upload was interrupted/],[false,'TypeError',/offline/],[true,'NotReadableError',/could not be read/]]){Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:online}});globalThis.fetch=async()=>{const e=new Error('private');e.name=name;throw e};await assert.rejects(request('/api/conversations/1/messages/image'),e=>{assert.match(e.displayMessage,text);assert.doesNotMatch(e.displayMessage,/private/);return true})}}finally{globalThis.fetch=saved;if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator}})
test('XHR measures bytes, reports server processing only after upload and supports abort',async()=>{
 const saved=globalThis.XMLHttpRequest;let xhr,progress,uploaded=false
 globalThis.XMLHttpRequest=class{upload={};headers={};status=201;response=new Blob(['{}']);constructor(){xhr=this}open(method,url){assert.equal(method,'POST');assert.equal(url,'/qa')}setRequestHeader(k,v){this.headers[k]=v}getResponseHeader(){return null}send(body){this.body=body}abort(){this.onabort?.()}}
 try{const c=new AbortController(),body=new FormData(),pending=uploadMultipart('/qa',{body,headers:{Authorization:'Bearer qa-only'},signal:c.signal,onProgress:p=>{progress=p},onUploaded:()=>{uploaded=true}});assert.equal(xhr.headers['Content-Type'],undefined);assert.equal(xhr.body,body);xhr.upload.onprogress({lengthComputable:true,loaded:40,total:100});assert.deepEqual(progress,{loaded:40,total:100});assert.equal(uploaded,false);xhr.upload.onprogress({lengthComputable:false});assert.equal(progress,null);xhr.upload.onload();assert.equal(uploaded,true);xhr.onload();assert.equal((await pending).status,201);const cancelled=uploadMultipart('/qa',{body,headers:{},signal:c.signal});c.abort();await assert.rejects(cancelled,{name:'AbortError'})}finally{globalThis.XMLHttpRequest=saved}
})
