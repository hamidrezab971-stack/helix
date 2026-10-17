// Evidence comes only from the disposable browser fixtures, never production.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const responses = new WeakMap()

function redact(value) {
  return String(value).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|access_token|password|secret|solution)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/password123/g, '[redacted fixture password]')
}

function observe(page) {
  const recent = []
  responses.set(page, recent)
  page.on('response', response => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/')) return
    // No headers, query strings, request/response bodies or auth frames.
    recent.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    if (recent.length > 80) recent.shift()
  })
}

async function captureFailure(browser, error) {
  const root = process.env.HELIX_BROWSER_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-browser-evidence-'))
  const phase = path.basename(process.argv[1] || 'browser', '.cjs')
  const directory = path.join(root, phase)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const report = { phase, error: redact(error?.stack || error), browser: browser?.version(), pages: [] }
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    const result = { index, responses: responses.get(page) || [] }
    report.pages.push(result)
    try {
      const snapshot = await page.evaluate(() => {
        const rt = window.realtimeTest
        const rows = [...document.querySelectorAll('.recent-row')].map(row => {
          const item = row.closest('li')
          const indicator = item?.querySelector('.avatar-presence')
          return { username: row.querySelector('.conversation-name')?.textContent,
            conversationId: item?.dataset.conversationId, removing: item?.dataset.removing,
            childIndicators: row.querySelectorAll('.avatar-presence').length,
            itemIndicators: item?.querySelectorAll('.avatar-presence').length,
            online: indicator?.dataset.online, opacity: indicator && getComputedStyle(indicator).opacity }
        })
        const dom = document.body.cloneNode(true)
        dom.querySelectorAll('script,style,iframe,object,embed,altcha-widget').forEach(node => node.remove())
        dom.querySelectorAll('input,textarea').forEach(node => { node.textContent = ''; node.removeAttribute('value') })
        const allowed = /^(class|id|role|hidden|disabled|inert|aria-[\w-]+|data-(online|conversation-id|removing|chat-open))$/
        for (const node of [dom, ...dom.querySelectorAll('*')]) {
          for (const attr of [...node.attributes]) if (!allowed.test(attr.name)) node.removeAttribute(attr.name)
        }
        return { dom: dom.outerHTML, rows, location: location.pathname,
          connection: document.querySelector('.connection-status')?.textContent,
          realtime: rt && { authenticated: rt.authenticated, closed: rt.closed, readyState: rt.socket?.readyState,
            lastPresence: rt.received.filter(e => ['presence:snapshot', 'presence:update'].includes(e.type)).slice(-12)
              .map(e => ({ type: e.type, online_user_ids: e.data?.online_user_ids, user_id: e.data?.user_id, status: e.data?.status })),
            typingSent: rt.sentTyping.length, messagesReceived: rt.events.length,
            clearEvents: rt.cleared.length,
            lastClearBoundaries: rt.cleared.slice(-8).map(e => ({ conversation_id: e.conversation_id, cleared_through_id: e.cleared_through_id })) } }
      })
      const { dom, ...state } = snapshot
      Object.assign(result, state)
      fs.writeFileSync(path.join(directory, `page-${index}.html`), redact(dom), { mode: 0o600 })
      await page.screenshot({ path: path.join(directory, `page-${index}.png`), fullPage: true,
        mask: [page.locator('input,textarea,altcha-widget')] })
      fs.chmodSync(path.join(directory, `page-${index}.png`), 0o600)
    } catch (captureError) { result.captureError = redact(captureError.message) }
  }
  fs.writeFileSync(path.join(directory, 'failure.json'), redact(JSON.stringify(report, null, 2)), { mode: 0o600 })
  console.error(`Browser failure evidence: ${directory}`)
  return directory
}

module.exports = { observe, captureFailure, redact }
