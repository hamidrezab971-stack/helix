import test from 'node:test'
import assert from 'node:assert/strict'
import { cropGeometry, pinchCrop, cropImageDimensions, prepareCropImage } from '../src/utils/crop.js'
import { codePointLength, normalizeBiography, createPhotoCache, mergeProfileSummaries } from '../src/services/profiles.js'

for (const [w,h] of [[1800,900],[900,1800],[1000,1000]]) {
  test(`Square crop stays covered across zoom and extreme pan: ${w}×${h}`, () => {
    for (const zoom of [1,1.5,4]) for (const x of [-10000,0,10000]) for(const y of [-10000,0,10000]) {
      const g=cropGeometry(w,h,320,zoom,x,y)
      assert.ok(g.sx>=0 && g.sy>=0)
      assert.ok(g.sx+g.side<=w+1e-8 && g.sy+g.side<=h+1e-8)
      assert.ok(Math.abs(g.side*g.scale-320)<1e-8)
    }
  })
}
test('Pinching preserves the image point under the midpoint without a jump', () => {
  const start={zoom:2,x:30,y:-20,distance:100,midpoint:{x:25,y:10}}
  const before=cropGeometry(1000,900,320,start.zoom,start.x,start.y)
  const next=pinchCrop(start,{x:25,y:10},150,1000,900,320)
  assert.equal(next.zoom,3)
  assert.ok(Math.abs(25/before.scale-before.x-(25/next.scale-next.x))<1e-8)
  assert.ok(Math.abs(10/before.scale-before.y-(10/next.scale-next.y))<1e-8)
})
test('Dragging uses source coordinates and does not change zoom', () => {
  const start={zoom:2,x:0,y:0,distance:1,midpoint:{x:0,y:0}}
  const result=pinchCrop(start,{x:20,y:10},1,1000,1000,320)
  assert.equal(result.zoom,2);assert.equal(result.x*result.scale,20);assert.equal(result.y*result.scale,10)
})
test('Zoom and viewport changes keep output in bounds', () => {
  assert.equal(cropGeometry(1000,1000,320,.1).scale,.32)
  assert.equal(cropGeometry(1000,1000,320,100).scale,1.28)
  const small=cropGeometry(1000,1000,200,2,40,30),large=cropGeometry(1000,1000,400,2,40,30)
  assert.equal(small.sx,large.sx);assert.equal(small.sy,large.sy)
})
test('Unicode counting agrees with Python code points for Persian, emoji and joined emoji', () => {
  assert.equal(codePointLength('سلام'),4)
  assert.equal(codePointLength('😀'.repeat(1000)),1000)
  assert.equal(codePointLength('👩🏽‍💻'),4)
  assert.equal(codePointLength('a\r\nb\rc'),5)
  assert.equal(normalizeBiography('سلام\r\nHello\r😀'),'سلام\nHello\n😀')
})

function cacheHarness(get) {
  const created=[],revoked=[]
  const cache=createPhotoCache('session',()=>{}, {get,urls:{createObjectURL(blob){const url=`blob:${created.length}`;created.push([url,blob]);return url},revokeObjectURL(url){revoked.push(url)}}})
  return {cache,created,revoked}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))

function pngDimensions(width, height) {
  const bytes=new Uint8Array(24), view=new DataView(bytes.buffer)
  bytes.set([137,80,78,71,13,10,26,10],0);bytes.set([73,72,68,82],12)
  view.setUint32(16,width);view.setUint32(20,height)
  return bytes.buffer
}
test('Image dimensions reject compressed pixel bombs before allocating a browser decoder', async()=>{
  assert.throws(()=>cropImageDimensions(pngDimensions(100000,100000)),/smaller dimensions/)
  let created=false
  const saved=URL.createObjectURL
  URL.createObjectURL=()=>{created=true;throw new Error('decoder must not be reached')}
  try {
    await assert.rejects(prepareCropImage(new Blob([pngDimensions(100000,100000)],{type:'image/png'})),/smaller dimensions/)
    assert.equal(created,false)
  } finally {URL.createObjectURL=saved}
})
test('PNG dimensions accept the pixel boundary and reject invalid aspect ratios and truncation',()=>{
  assert.deepEqual(cropImageDimensions(pngDimensions(8000,4000)),{width:8000,height:4000})
  assert.throws(()=>cropImageDimensions(pngDimensions(8001,4000)),/smaller dimensions/)
  assert.throws(()=>cropImageDimensions(pngDimensions(100,1)),/smaller dimensions/)
  assert.throws(()=>cropImageDimensions(pngDimensions(0,100)),/valid/)
  assert.throws(()=>cropImageDimensions(new ArrayBuffer(1)),/valid/)
})
test('JPEG dimensions skip EXIF segments and support progressive SOF before decoding',()=>{
  const bytes=new Uint8Array([255,216,255,225,0,4,0,0,255,194,0,8,8,3,32,4,176,0])
  assert.deepEqual(cropImageDimensions(bytes.buffer),{width:1200,height:800})
  assert.throws(()=>cropImageDimensions(bytes.buffer.slice(0,16)),/valid/)
})
for(const kind of ['VP8X','VP8 ','VP8L'])test(`WebP ${kind} dimensions are checked before decoding`,()=>{
  const bytes=new Uint8Array(30),view=new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'),0);bytes.set(new TextEncoder().encode('WEBP'+kind),8)
  view.setUint32(16,10,true)
  if(kind==='VP8X') {bytes[24]=63;bytes[27]=31}
  if(kind==='VP8 ') {bytes.set([157,1,42],23);view.setUint16(26,64,true);view.setUint16(28,32,true)}
  if(kind==='VP8L') {bytes[20]=47;view.setUint32(21,63+(31<<14),true)}
  assert.deepEqual(cropImageDimensions(bytes.buffer),{width:64,height:32})
  view.setUint32(16,1000,true)
  assert.throws(()=>cropImageDimensions(bytes.buffer),/valid/)
})
test('New avatar versions win over delayed list responses, including deleting the final photo',()=>{
 let summaries=mergeProfileSummaries({}, {id:1,primary_photo_id:4,profile_version:2})
 summaries=mergeProfileSummaries(summaries,{id:1,primary_photo_id:null,profile_version:3})
 const stale=mergeProfileSummaries(summaries,{id:1,primary_photo_id:4,profile_version:2})
 assert.equal(stale,summaries);assert.equal(stale[1].primary_photo_id,null)
 for(let id=2;id<=200;id++)summaries=mergeProfileSummaries(summaries,{id,primary_photo_id:null,profile_version:1})
 assert.equal(Object.keys(summaries).length,128)
})
test('Avatar subscribers and conversation switches share an authenticated fetch', async () => {
  let calls=0
  const {cache,created,revoked}=cacheHarness(async()=>{calls++;return new Blob(['photo'])})
  const a=[],b=[]
  const release=cache.acquire(1,url=>a.push(url));cache.acquire(1,url=>b.push(url))
  await flush();assert.equal(calls,1);assert.equal(a.at(-1),b.at(-1));assert.equal(created.length,1)
  release();cache.acquire(1,()=>{});assert.equal(calls,1)
  cache.dispose();assert.deepEqual(revoked,['blob:0'])
})
test('Avatar cache is bounded, evicts idle blobs, and revokes everything on logout', async () => {
  const {cache,revoked}=cacheHarness(async id=>new Blob([String(id)]))
  for(let i=1;i<=100;i++){const release=cache.acquire(i,()=>{});await flush();release()}
  assert.equal(cache.size,64);assert.equal(revoked.length,36)
  cache.dispose();assert.equal(cache.size,0);assert.equal(revoked.length,100)
})
test('Pending image fetches are aborted without creating leaked object URLs', async () => {
  let finish,signal
  const {cache,created}=cacheHarness((_id,s)=>{signal=s;return new Promise(resolve=>finish=resolve)})
  cache.acquire(1,()=>{});cache.dispose();finish(new Blob(['late']))
  await flush();assert.ok(signal.aborted);assert.equal(created.length,0)
})
test('Leaving the viewport aborts the last pending subscriber while preserving shared downloads', async () => {
  let signal
  const {cache}=cacheHarness((_id,s)=>{signal=s;return new Promise(()=>{})})
  const first=cache.acquire(1,()=>{}),second=cache.acquire(1,()=>{})
  first();assert.equal(signal.aborted,false)
  second();assert.equal(signal.aborted,true);assert.equal(cache.size,0)
})
test('An image failure can be retried and session cache survives React effect remounts', async () => {
  let count=0
  const {cache}=cacheHarness(async()=>{if(!count++)throw new Error('offline');return new Blob(['ok'])})
  cache.acquire(1,()=>{});await flush();assert.equal(cache.size,0)
  cache.dispose();const result=[];cache.acquire(1,url=>result.push(url));await flush()
  assert.equal(count,2);assert.equal(result.at(-1),'blob:0');cache.dispose()
})
