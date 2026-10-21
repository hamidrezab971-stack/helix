// XHR exposes measured upload progress; Fetch cannot measure bytes sent.
// Let the browser generate the multipart boundary. Never set Content-Type.
export function uploadMultipart(url, { body, headers, signal, onProgress, onUploaded }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abortError = () => new DOMException('Canceled', 'AbortError')
    const abort = () => { xhr.abort(); reject(abortError()) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    xhr.open('POST', url)
    xhr.responseType = 'blob'
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => onProgress?.(event.lengthComputable && event.total > 0
      ? { loaded: event.loaded, total: event.total } : null)
    xhr.upload.onload = () => onUploaded?.()
    xhr.onload = () => {
      cleanup()
      if (!xhr.status) { reject(new TypeError('Upload transport failed')); return }
      resolve(new Response(xhr.response, { status: xhr.status, headers: {
        'Content-Type': xhr.getResponseHeader('Content-Type') || '',
        'Retry-After': xhr.getResponseHeader('Retry-After') || '',
      } }))
    }
    xhr.onerror = () => { cleanup(); reject(new TypeError('Upload transport failed')) }
    xhr.onabort = () => { cleanup(); reject(abortError()) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { cleanup(); reject(abortError()); return }
    try { xhr.send(body) } catch (error) { cleanup(); reject(error) }
  })
}
