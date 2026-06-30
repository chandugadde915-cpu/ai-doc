import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { useZoomPan } from '../hooks/useZoomPan'

export default function Lightbox({ src, filename, onClose }) {
  const zoom = useZoomPan()

  useEffect(() => {
    if (!src) return
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [src, onClose])

  useEffect(() => {
    if (src) requestAnimationFrame(() => zoom.fit())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <AnimatePresence>
      {src && (
        <motion.div
          className="preview-lightbox"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <div className="lightbox-toolbar">
            <span>{filename || 'Document preview'}</span>
            <div className="lightbox-zoom-controls">
              <button type="button" onClick={zoom.zoomOut}>
                -
              </button>
              <span className="zoom-level">{Math.round(zoom.scale * 100)}%</span>
              <button type="button" onClick={zoom.zoomIn}>
                +
              </button>
              <button type="button" onClick={zoom.fit}>
                Fit
              </button>
              <button type="button" className="expand-button" onClick={onClose}>
                ✕ Close
              </button>
            </div>
          </div>
          <motion.div
            ref={zoom.viewportRef}
            className={`zoom-viewport lightbox-viewport ${zoom.isDragging ? 'is-dragging' : ''}`}
            onWheel={zoom.handlers.onWheel}
            onMouseDown={zoom.handlers.onMouseDown}
            onMouseMove={zoom.handlers.onMouseMove}
            onMouseUp={zoom.handlers.onMouseUp}
            onMouseLeave={zoom.handlers.onMouseUp}
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <img
              ref={zoom.imageRef}
              className="zoom-target"
              src={src}
              alt="Document preview, expanded"
              style={{ transform: `translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})` }}
              draggable={false}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
