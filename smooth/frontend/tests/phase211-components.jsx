import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup as render } from 'react-dom/server'
import Icon, { iconNames } from '../src/components/ui/Icon.jsx'
import ChatComposer from '../src/components/chat/ChatComposer.jsx'
import PendingMessage from '../src/components/chat/PendingMessage.jsx'
const noop=()=>{}
test('Every HELIX icon has SVG geometry, consistent optics and no focusable child control',()=>{
 for(const name of iconNames){const markup=render(<Icon name={name} />);assert.match(markup,/<(?:path|circle|rect|g)\b/);assert.match(markup,/viewBox="0 0 24 24"/);assert.match(markup,/stroke-width="1.75"/);assert.match(markup,/focusable="false"/);assert.match(markup,/aria-hidden="true"/);assert.match(markup,/class="helix-icon"/)}
 for(const name of ['chat','people','settings','person','back','compose','search','image','send','close','retry','reply','edit','trash','copy','check','checks','camera','star','more','smile','clock','alert'])assert.ok(iconNames.includes(name),name)
})
test('Preparing an image blocks Send while keeping a named remove control and compact preview',()=>{
 const props={content:'',onChange:noop,onSubmit:noop,onImage:noop,onRemoveImage:noop,onCancelReply:noop,replyName:noop,replyText:noop}
 const markup=render(<ChatComposer {...props} preparingImage />)
 assert.match(markup,/Preparing photo/);assert.match(markup,/aria-label="Remove image"/);assert.match(markup,/aria-label="Send"[^>]*disabled/)
 assert.doesNotMatch(markup,/<img[^>]*src=""/)
})
test('Pending progress is indeterminate until transport supplies real byte counts',()=>{
 const entry={localId:'qa',content:'',enteredAt:performance.now(),state:'uploading',progress:null}
 const unknown=render(<PendingMessage entry={entry} onCancel={noop} />)
 assert.match(unknown,/<progress[^>]*aria-label="Image upload progress"/);assert.doesNotMatch(unknown,/<progress[^>]*value=/);assert.match(unknown,/Cancel send/)
 const measured=render(<PendingMessage entry={{...entry,progress:{loaded:20,total:100}}} />)
 assert.match(measured,/<progress[^>]*max="100"[^>]*value="20"/)
})
test('Failed sends expose retry and dismiss actions; rejected sends only offer dismissal',()=>{
 const entry={localId:'qa',content:'',enteredAt:performance.now(),state:'failed',error:'Upload interrupted'}
 const markup=render(<PendingMessage entry={entry} onRetry={noop} onDismiss={noop} />)
 assert.match(markup,/Retry message/);assert.match(markup,/Dismiss message/);assert.match(markup,/role="alert"/);assert.match(markup,/data-icon="retry"/)
 assert.doesNotMatch(render(<PendingMessage entry={{...entry,terminal:true}} onDismiss={noop} />),/Retry message/)
 assert.match(render(<PendingMessage entry={{...entry,state:'cancelled'}} onDismiss={noop} />),/Cancelled/)
})
