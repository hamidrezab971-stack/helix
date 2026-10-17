import { useCallback, useEffect, useRef, useState } from 'react'
import useDialog from '../../hooks/useDialog.js'
import { cropGeometry, pinchCrop, exportCrop, cropErrorMessage } from '../../utils/crop.js'

export default function CropDialog({ image, onClose, onSave }) {
  const dialog = useRef(null), stage = useRef(null), pending = useRef(false)
  const [viewport, setViewport] = useState(280)
  const [crop, setCrop] = useState({ zoom: 1, x: 0, y: 0 })
  const current = useRef(crop); current.current = crop
  const points = useRef(new Map()), gesture = useRef(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const close = useCallback(() => { if (!pending.current) onClose() }, [onClose])
  useDialog(dialog, close)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setViewport(Math.max(120, Math.min(entry.contentRect.width - 40, entry.contentRect.height - 48, 420))))
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  const geometry = cropGeometry(image.width, image.height, viewport, crop.zoom, crop.x, crop.y)
  function update(next) {
    const value = { ...next, ...cropGeometry(image.width, image.height, viewport, next.zoom, next.x, next.y) }
    current.current = value; setCrop(value)
  }
  function snapshot() {
    const p = [...points.current.values()]
    if (!p.length) { gesture.current = null; return }
    const rect = stage.current.getBoundingClientRect()
    const mid = p.length > 1 ? { x:(p[0].x+p[1].x)/2, y:(p[0].y+p[1].y)/2 } : p[0]
    gesture.current = { ...current.current, midpoint:{ x:mid.x-rect.left-rect.width/2, y:mid.y-rect.top-rect.height/2 }, distance:p.length>1 ? Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) : 1 }
  }
  function move(event) {
    if (!points.current.has(event.pointerId) || !gesture.current || pending.current) return
    points.current.set(event.pointerId,{ x:event.clientX,y:event.clientY })
    const p = [...points.current.values()], rect = stage.current.getBoundingClientRect()
    const mid = p.length>1 ? { x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2 } : p[0]
    update(pinchCrop(gesture.current, {x:mid.x-rect.left-rect.width/2,y:mid.y-rect.top-rect.height/2}, p.length>1 ? Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) : 1, image.width,image.height,viewport))
  }
  async function save() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onSave(await exportCrop(image, geometry)) }
    catch (error) { setError(error.displayMessage || cropErrorMessage(error)) }
    finally { pending.current = false; setBusy(false) }
  }
  const pan = (x,y) => update({ ...crop, x:geometry.x+x/geometry.scale, y:geometry.y+y/geometry.scale })
  return <div className="identity-overlay"><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="crop-title" className="crop-dialog" aria-busy={busy}>
    <header className="identity-toolbar"><button type="button" onClick={close} disabled={busy}>Cancel</button><h2 id="crop-title">Choose your crop</h2><button type="button" className="text-button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save photo'}</button></header>
    <div ref={stage} className="crop-stage" style={{ '--crop-size':`${viewport}px` }}
      onPointerDown={event => { if (pending.current || points.current.size>=2 || event.button>0) return; event.currentTarget.setPointerCapture(event.pointerId); points.current.set(event.pointerId,{x:event.clientX,y:event.clientY}); snapshot() }}
      onPointerMove={move} onPointerUp={event => { points.current.delete(event.pointerId); snapshot() }} onPointerCancel={event => { points.current.delete(event.pointerId); snapshot() }}>
      <img draggable="false" src={image.url} alt="Selected photo" style={{ width:image.width*geometry.scale, height:image.height*geometry.scale, transform:`translate(calc(-50% + ${geometry.x*geometry.scale}px), calc(-50% + ${geometry.y*geometry.scale}px))` }} />
      <div className="crop-boundary" aria-hidden="true"><i /><i /><i /><i /></div>
    </div>
    <div className="crop-controls"><label htmlFor="crop-zoom">Zoom</label><input id="crop-zoom" type="range" min="1" max="4" step=".01" value={crop.zoom} disabled={busy} onChange={event => update({ ...crop, zoom:Number(event.target.value) })} />
      <div className="crop-position" aria-label="Position photo">{[['←',-20,0,'Move photo left'],['↑',0,-20,'Move photo up'],['↓',0,20,'Move photo down'],['→',20,0,'Move photo right']].map(([label,x,y,name]) => <button type="button" key={name} aria-label={name} disabled={busy} onClick={() => pan(x,y)}>{label}</button>)}<button type="button" disabled={busy} onClick={() => update({zoom:1,x:0,y:0})}>Reset</button></div>
      <p className="profile-hint">Drag to position · Pinch or use the zoom slider</p>{error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </section></div>
}
