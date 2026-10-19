export function cropGeometry(width, height, viewport, zoom = 1, x = 0, y = 0) {
  const scale = Math.max(viewport / width, viewport / height) * Math.max(1, Math.min(4, zoom))
  const side = viewport / scale
  const maxX = (width - side) / 2, maxY = (height - side) / 2
  x = Math.max(-maxX, Math.min(maxX, x)); y = Math.max(-maxY, Math.min(maxY, y))
  return { scale, x, y, side, sx: (width - side) / 2 - x, sy: (height - side) / 2 - y }
}

export function pinchCrop(start, midpoint, distance, width, height, viewport) {
  const zoom = Math.max(1, Math.min(4, start.zoom * distance / Math.max(1, start.distance)))
  const old = cropGeometry(width, height, viewport, start.zoom, start.x, start.y)
  const scale = cropGeometry(width, height, viewport, zoom).scale
  return { zoom, ...cropGeometry(width, height, viewport, zoom,
    old.x + midpoint.x / scale - start.midpoint.x / old.scale,
    old.y + midpoint.y / scale - start.midpoint.y / old.scale) }
}

// Read dimensions before browser decoding: a small compressed file can expand
// into an enormous bitmap. Orientation can swap these axes, not their product.
export function cropImageDimensions(buffer, { maxPixels = 32000000, maxDimension = Infinity, maxAspect = 12 } = {}) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer)
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length))
  const invalid = () => { throw new Error('Choose a valid JPEG, PNG or WebP image.') }
  let width, height
  if (bytes.length >= 24 && ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20)
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) invalid()
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) invalid()
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) invalid()
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) invalid()
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5)
        break
      }
      offset += length
    }
  } else if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    let offset = 12
    const uint24 = start => bytes[start] + bytes[start + 1] * 256 + bytes[start + 2] * 65536
    while (offset + 8 <= bytes.length) {
      const kind = ascii(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8
      if (start + length > bytes.length) invalid()
      if (kind === 'VP8X' && length >= 10) {
        width = 1 + uint24(start + 4); height = 1 + uint24(start + 7); break
      }
      if (kind === 'VP8 ' && length >= 10 && ascii(start + 3, 3) === '\x9d\x01\x2a') {
        width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff; break
      }
      if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
        const bits = view.getUint32(start + 1, true)
        width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); break
      }
      offset = start + length + (length & 1)
    }
  }
  if (!width || !height) invalid()
  if (width * height > maxPixels || Math.max(width, height) > maxDimension || Math.max(width / height, height / width) > maxAspect) {
    throw new Error('Choose a photo with smaller dimensions.')
  }
  return { width, height }
}

export class CropImageError extends Error {
  constructor(stage, message) { super(message); this.name = 'CropImageError'; this.stage = stage }
}

export function cropErrorMessage(error) {
  return error instanceof CropImageError ? error.message : 'Unable to open this photo. Please choose it again.'
}

function abortCheck(signal) { if (signal?.aborted) throw new DOMException('Canceled', 'AbortError') }

// FileReader starts consuming the provider handle synchronously. A Blob made
// from the resulting bytes owns its data; slice(), new Blob([file]) and a URL
// pointing at the original File can still depend on the Android provider.
export function readSelectedImage(file, signal) {
  abortCheck(signal)
  if (typeof FileReader === 'undefined') {
    return file.arrayBuffer().then(bytes => { abortCheck(signal); return bytes }, () => {
      throw new CropImageError('read', 'This photo could not be read. Please select it again from Gallery or Files.')
    })
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => { reader.abort(); reject(new DOMException('Canceled', 'AbortError')) }
    const finish = fn => value => { signal?.removeEventListener('abort', abort); fn(value) }
    reader.onload = finish(() => resolve(reader.result))
    reader.onerror = finish(() => reject(new CropImageError('read', 'This photo could not be read. Please select it again from Gallery or Files.')))
    reader.onabort = finish(() => reject(new DOMException('Canceled', 'AbortError')))
    signal?.addEventListener('abort', abort, { once: true })
    try { reader.readAsArrayBuffer(file) }
    catch { signal?.removeEventListener('abort', abort); reject(new CropImageError('read', 'This photo could not be read. Please select it again from Gallery or Files.')) }
  })
}

export function loadImage(url, signal) {
  abortCheck(signal)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    const cleanup = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('Canceled', 'AbortError')) }
    image.onload = () => { cleanup(); resolve(image) }
    image.onerror = () => { cleanup(); reject(new CropImageError('decode', 'Unable to open this photo. Please choose another JPEG, PNG or WebP image.')) }
    signal?.addEventListener('abort', abort, { once: true })
    image.src = url
  })
}

async function canvasBlob(canvas, quality) {
  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality))
    if (blob) return blob
  } catch { /* Canvas errors are recoverable; never show the browser exception. */ }
  throw new CropImageError('encode', 'Unable to prepare the photo. Please try again or choose a smaller image.')
}

export async function prepareCropImage(file, { signal, onRead } = {}) {
  if (!['', 'application/octet-stream', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new CropImageError('validate', 'Choose a JPEG, PNG or WebP image.')
  if (!file.size || file.size > 16 * 1024 * 1024) throw new CropImageError('validate', 'Choose an image of 16 MB or smaller.')
  let bytes = await readSelectedImage(file, signal)
  abortCheck(signal)
  onRead?.() // Only now may the input release its native selection.
  if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new CropImageError('validate', 'Choose an image of 16 MB or smaller.')
  try { cropImageDimensions(bytes) } catch (error) { throw new CropImageError('validate', error.message) }
  const signature = new Uint8Array(bytes, 0, 1)[0]
  const mime = signature === 255 ? 'image/jpeg' : signature === 137 ? 'image/png' : 'image/webp'
  const original = URL.createObjectURL(new Blob([bytes], { type: mime }))
  bytes = null
  let canvas, image
  try {
    image = await loadImage(original, signal) // Browser applies EXIF orientation.
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32000000 || Math.max(image.naturalWidth / image.naturalHeight, image.naturalHeight / image.naturalWidth) > 12) throw new CropImageError('validate', 'Choose a photo with smaller dimensions.')
    const ratio = Math.min(1, 1536 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new CropImageError('decode', 'Unable to prepare this photo. Please try again.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await canvasBlob(canvas, .94)
    abortCheck(signal)
    const url = URL.createObjectURL(blob)
    let disposed = false
    return { url, width: canvas.width, height: canvas.height,
      dispose() { if (!disposed) { disposed = true; URL.revokeObjectURL(url) } } }
  } finally {
    if (image) image.src = ''
    if (canvas) canvas.width = canvas.height = 0
    URL.revokeObjectURL(original)
  }
}

export async function exportCrop(image, geometry) {
  const source = await loadImage(image.url)
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
  try {
    canvas.getContext('2d').drawImage(source, geometry.sx, geometry.sy, geometry.side, geometry.side, 0, 0, 512, 512)
    return await canvasBlob(canvas, .9)
  } finally { source.src = ''; canvas.width = canvas.height = 0 }
}
