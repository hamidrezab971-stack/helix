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
export function cropImageDimensions(buffer) {
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
  if (width * height > 32000000 || Math.max(width / height, height / width) > 12) {
    throw new Error('Choose a photo with smaller dimensions.')
  }
  return { width, height }
}

export async function prepareCropImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.')
  if (file.size > 16 * 1024 * 1024) throw new Error('Choose an image of 16 MB or smaller.')
  cropImageDimensions(await file.arrayBuffer())
  const original = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise((resolve,reject) => {
      image.onload=resolve; image.onerror=() => reject(new Error('Unable to open this image.'))
      image.src=original
    }) // natural dimensions include the browser's EXIF orientation.
    if (image.naturalWidth * image.naturalHeight > 32000000 || Math.max(image.naturalWidth / image.naturalHeight, image.naturalHeight / image.naturalWidth) > 12) throw new Error('Choose a photo with smaller dimensions.')
    const ratio = Math.min(1, 1536 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const bitmap = globalThis.createImageBitmap ? await createImageBitmap(image, {
      resizeWidth:canvas.width, resizeHeight:canvas.height, resizeQuality:'high',
    }) : image
    try { canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height) }
    finally { bitmap.close?.() }
    image.src = ''
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .94))
    if (!blob) throw new Error('Unable to open this image. Please choose another.')
    return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height }
  } finally { URL.revokeObjectURL(original) }
}

export async function exportCrop(image, geometry) {
  const source = new Image()
  source.src = image.url
  await source.decode()
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
  canvas.getContext('2d').drawImage(source, geometry.sx, geometry.sy, geometry.side, geometry.side, 0, 0, 512, 512)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .9))
  if (!blob) throw new Error('Unable to save the crop. Please try again.')
  return blob
}
