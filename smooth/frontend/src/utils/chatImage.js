import { cropImageDimensions, readSelectedImage, loadImage } from './crop.js'

export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_PENDING_IMAGE_BYTES = 32 * 1024 * 1024
export const activeSendStates = new Set(['queued', 'uploading', 'sending', 'retrying'])

export function chatImageError(error) {
  return error?.name === 'CropImageError' || error?.name === 'ChatImageError'
    ? error.message : 'Unable to prepare this photo. Please select it again from Gallery or Files.'
}
function invalid(message) {
  const error = new Error(message)
  error.name = 'ChatImageError'
  throw error
}

// Start FileReader in the input change event. Clearing the picker, File.slice(),
// or wrapping a provider-backed File in a Blob does not acquire its bytes.
export async function prepareChatImage(file, { signal, onRead } = {}) {
  if (!['', 'application/octet-stream', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) invalid('Choose a JPEG, PNG or WebP image.')
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) invalid('Choose an image of 8 MB or smaller.')
  let bytes = await readSelectedImage(file, signal)
  onRead?.()
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError')
  if (!bytes.byteLength || bytes.byteLength > MAX_CHAT_IMAGE_BYTES) invalid('Choose an image of 8 MB or smaller.')
  try { cropImageDimensions(bytes, { maxPixels: 25000000, maxDimension: 16000, maxAspect: Infinity }) }
  catch { invalid('Choose a valid JPEG, PNG or WebP image up to 25 megapixels and 16000 pixels per side.') }
  const first = new Uint8Array(bytes, 0, 1)[0]
  const type = first === 255 ? 'image/jpeg' : first === 137 ? 'image/png' : 'image/webp'
  if (file.type.startsWith('image/') && file.type !== type) invalid('The image format does not match its file type. Please choose another photo.')
  const blob = new Blob([bytes], { type })
  bytes = null
  const url = URL.createObjectURL(blob)
  let image
  try {
    image = await loadImage(url, signal) // Includes the browser's EXIF orientation.
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height || width * height > 25000000 || Math.max(width, height) > 16000) invalid('Choose a photo with smaller dimensions.')
    return { blob, name: String(file.name || `photo.${type === 'image/jpeg' ? 'jpg' : type.split('/')[1]}`).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 150), width, height }
  } finally {
    if (image) image.src = ''
    URL.revokeObjectURL(url)
  }
}
