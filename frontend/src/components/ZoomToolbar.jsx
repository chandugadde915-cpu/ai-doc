import { motion } from 'framer-motion'

export default function ZoomToolbar({ scale, onZoomIn, onZoomOut, onFit, onReset, onExpand, dark = false }) {
  return (
    <motion.div
      className={`zoom-toolbar ${dark ? 'zoom-toolbar-dark' : ''}`}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <button type="button" onClick={onZoomOut} title="Zoom out">
        -
      </button>
      <span className="zoom-level">{Math.round(scale * 100)}%</span>
      <button type="button" onClick={onZoomIn} title="Zoom in">
        +
      </button>
      <button type="button" onClick={onFit} title="Fit to view">
        Fit
      </button>
      {onReset && (
        <button type="button" onClick={onReset} title="Reset zoom">
          100%
        </button>
      )}
      {onExpand && (
        <button type="button" className="expand-button" onClick={onExpand} title="Open full screen">
          ⤢ Expand
        </button>
      )}
      <span className="zoom-hint">Scroll to zoom · drag to pan</span>
    </motion.div>
  )
}
