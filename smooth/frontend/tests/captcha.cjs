const { pbkdf2Sync }=require('node:crypto')
async function solve(request,purpose) {
 const response=await request.get(`http://127.0.0.1:8000/api/auth/challenge?purpose=${purpose}`)
 if(response.status()!==200)throw new Error('Unable to issue real QA challenge: '+response.status())
 const challenge=await response.json(),p=challenge.parameters
 if(p.algorithm!=='PBKDF2/SHA-256' || p.cost>10000)throw new Error('Unexpected QA challenge algorithm/cost')
 for(let counter=0;counter<100000;counter++){
  const suffix=Buffer.alloc(4);suffix.writeUInt32BE(counter)
  const key=pbkdf2Sync(Buffer.concat([Buffer.from(p.nonce,'hex'),suffix]),Buffer.from(p.salt,'hex'),p.cost,p.keyLength,'sha256').toString('hex')
  if(key.startsWith(p.keyPrefix))return Buffer.from(JSON.stringify({challenge,solution:{counter,derivedKey:key}})).toString('base64')
 }
 throw new Error('Real QA challenge solve limit exceeded')
}
async function ready(page){
 await page.waitForFunction(()=>typeof document.querySelector('altcha-widget')?.getState==='function')
 await page.locator('altcha-widget').evaluate(async widget=>{if(widget.getState()==='unverified')await widget.verify()})
 await require('playwright/test').expect(page.getByText('Verification ready.',{exact:true})).toBeVisible({timeout:90000})
}
module.exports={solve,ready}
