// Execute the actual vendored ALTCHA PBKDF2 worker in a VM, then verify its
// solution with the actual Python library. This does not simulate browser UI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

test('Official bundled ALTCHA worker solves Python v2 challenge and server verifies it', {timeout:30000}, async () => {
  const cwd=fileURLToPath(new URL('../../backend/',import.meta.url))
  const python=process.env.HELIX_QA_PYTHON || 'python3'
  const generate=spawnSync(python,['-c',`import json,time
from app.vendor.altcha import create_challenge
print(json.dumps(create_challenge('PBKDF2/SHA-256',5000,key_prefix='00',expires_at=int(time.time())+300,data={'purpose':'login','id':'interop'},hmac_secret='offline-interop-fixture-key').to_dict()))`],{cwd,encoding:'utf8',timeout:10000})
  assert.equal(generate.status,0,generate.stderr)
  const challenge=JSON.parse(generate.stdout)
  const source=readFileSync(new URL('../src/vendor/altcha.js',import.meta.url),'utf8')
  const prefix='const jsContent$1 = '
  const line=source.split('\n').find(line=>line.startsWith(prefix))
  assert.ok(line,'Expected the reviewed official PBKDF2 worker bundle')
  const worker=vm.runInNewContext(line.slice(prefix.length,-1))
  let result
  const self={postMessage:value=>{result=value}}
  vm.runInNewContext(worker,{self,crypto:webcrypto,performance,AbortController,TextEncoder,setTimeout,Uint8Array,DataView,ArrayBuffer})
  // Periodic wake also supports restricted containers that cannot wake an
  // idle event loop from a crypto thread. It changes no cryptographic check.
  const wake=setInterval(()=>{},25)
  try { await self.onmessage({data:{type:'work',challenge,counterStart:0,counterStep:1,timeout:30000}}) }
  finally { clearInterval(wake) }
  assert.ok(result && !result.error && Number.isInteger(result.counter))
  const verify=spawnSync(python,['-c',`import sys,json,base64
from app.vendor.altcha import verify_solution
payload=base64.b64encode(sys.argv[1].encode()).decode()
assert verify_solution(payload,'offline-interop-fixture-key').verified`,JSON.stringify({challenge,solution:result})],{cwd,encoding:'utf8',timeout:10000})
  assert.equal(verify.status,0,verify.stderr)
})
