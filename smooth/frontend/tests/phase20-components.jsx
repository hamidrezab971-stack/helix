import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { BiographyEditor, PhotoGallery } from '../src/components/profile/ProfilePanel.jsx'
import CropDialog from '../src/components/profile/CropDialog.jsx'
import Captcha from '../src/components/Captcha.jsx'
import Avatar from '../src/components/chat/Avatar.jsx'
const noop=()=>{}

test('Crop exposes square preview, cancel/save, zoom and four non-gesture position controls',()=>{
 const markup=render(<CropDialog image={{url:'blob:qa',width:1000,height:1600}} onClose={noop} onSave={noop} />)
 assert.match(markup,/role="dialog" aria-modal="true"/);assert.match(markup,/crop-boundary/)
 for(const label of ['Save photo','Cancel','Zoom','Move photo left','Move photo up','Move photo right','Move photo down','Reset'])assert.ok(markup.includes(label))
 assert.match(markup,/type="range" min="1" max="4"/)
})
test('Biography stays plain text with Unicode counter, clear and cancel',()=>{
 const text='سلام 😀 <script>alert(1)</script>'
 const markup=render(<BiographyEditor biography={text} onClose={noop} onSave={noop} />)
 assert.match(markup,/dir="auto"/);assert.match(markup,/Clear bio/);assert.ok(!markup.includes('<script>'))
 assert.match(markup,/&lt;script&gt;/);assert.ok(markup.includes(`${Array.from(text).length} / 1000`))
})
test('Over-limit biography visibly rejects save',()=>{
 const markup=render(<BiographyEditor biography={'😀'.repeat(1001)} onClose={noop} onSave={noop} />)
 assert.match(markup,/aria-invalid="true"/);assert.match(markup,/disabled=""[^>]*>Save/);assert.match(markup,/Use up to 1000 characters/)
})
test('Gallery navigation and fallback avatar have stable labelled controls',()=>{
 const profile={id:1,username:'alice',photos:[{id:4},{id:5}],primary_photo_id:4}
 const markup=render(<PhotoGallery profile={profile} />)
 assert.match(markup,/Previous photo/);assert.match(markup,/Next photo/);assert.match(markup,/aria-label="Profile photos"/)
 assert.match(render(<Avatar user={{username:'حمید'}} size="large" />),/ح/)
})
test('CAPTCHA exposes accessible loading status without a success default',()=>{
 const markup=render(<Captcha purpose="login" onSolution={noop} resetKey={0} />)
 assert.match(markup,/role="status" aria-live="polite"/);assert.match(markup,/Loading verification/);assert.ok(!markup.includes('Verification ready'))
})
