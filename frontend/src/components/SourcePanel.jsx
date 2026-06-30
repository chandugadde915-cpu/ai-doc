import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useZoomPan } from '../hooks/useZoomPan'
import { formatBytes, getExtension } from '../lib/dataUtils'
import ZoomToolbar from './ZoomToolbar'

export default function SourcePanel({ file, previewUrl, source, onExpand }) {
  const [tab, setTab] = useState('preview')
  const [pageIndex, setPageIndex] = useState(0)
  const zoom = useZoomPan()
  const imageReadyRef = useRef(false)

  const visualPages = Array.isArray(source?.visualPages) ? source.visualPages : []
  const hasRenderedPages = visualPages.length > 0
  const isImage = !hasRenderedPages && (source?.mimeType || file?.type || '').startsWith('image/')
  const isPdf = !hasRenderedPages && ((source?.mimeType || file?.type || '') === 'application/pdf' || /\.pdf$/i.test(file?.name || ''))
  const status = source?.extractionMethod || (file ? 'Selected file' : 'Waiting for upload')

  useEffect(() => {
    setTab('preview')
    setPageIndex(0)
    imageReadyRef.current = false
  }, [file, source])

  useEffect(() => {
    imageReadyRef.current = false
  }, [pageIndex])

  const handleImageLoad = () => {
    if (imageReadyRef.current) return
    imageReadyRef.current = true
    requestAnimationFrame(() => zoom.fit())
  }

  const meta = source
    ? [
        ['Filename', source.filename || 'Unknown'],
        ['MIME', source.mimeType || 'Unknown'],
        ['Pages', String(source.pages ?? 0)],
        ['Method', source.extractionMethod || 'Unknown'],
      ]
    : file
      ? [
          ['Filename', file.name],
          ['Type', file.type || 'Unknown'],
          ['Size', formatBytes(file.size)],
          ['Status', 'Ready to analyze'],
        ]
      : []

  const activePageSrc = hasRenderedPages ? visualPages[pageIndex]?.dataUrl : previewUrl

  const renderSurface = () => {
    if (tab === 'layout') {
      if (!source?.layout) return <Placeholder icon="LAY" title="No layout yet" detail="Layout JSON appears after analysis." />
      return <pre className="source-json-preview">{JSON.stringify(source.layout, null, 2).slice(0, 12000)}</pre>
    }

    if (tab === 'text') {
      const text = (source?.text || '').trim()
      if (!text) return <Placeholder icon="TXT" title="No transcript yet" detail="OCR or text extraction will appear here after analysis." />
      return <pre className="source-text-preview">{text.slice(0, 12000)}</pre>
    }

    if ((hasRenderedPages || isImage) && activePageSrc) {
      return (
        <div
          ref={zoom.viewportRef}
          className={`zoom-viewport ${zoom.isDragging ? 'is-dragging' : ''}`}
          onWheel={zoom.handlers.onWheel}
          onMouseDown={zoom.handlers.onMouseDown}
          onMouseMove={zoom.handlers.onMouseMove}
          onMouseUp={zoom.handlers.onMouseUp}
          onMouseLeave={zoom.handlers.onMouseUp}
        >
          <img
            ref={zoom.imageRef}
            key={activePageSrc}
            className="zoom-target"
            src={activePageSrc}
            alt={hasRenderedPages ? `Page ${visualPages[pageIndex]?.page || pageIndex + 1} preview` : 'Selected document preview'}
            onLoad={handleImageLoad}
            draggable={false}
            style={{ transform: `translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})` }}
          />
        </div>
      )
    }

    if (isPdf && previewUrl) {
      return <embed className="pdf-embed" src={previewUrl} type="application/pdf" title="PDF preview" />
    }

    if (file) {
      const extension = getExtension(file.name) || 'file'
      return (
        <div className="source-file-preview">
          <span className="source-file-badge">{extension.slice(0, 6)}</span>
          <strong>{file.name}</strong>
          <span>{file.type || 'This file type does not have a browser preview.'}</span>
        </div>
      )
    }

    return <Placeholder icon="SRC" title="No document selected" detail="The document preview, OCR transcript, and layout JSON appear here." />
  }

  const showZoomToolbar = tab === 'preview' && (hasRenderedPages || isImage) && activePageSrc
  const showPageStepper = tab === 'preview' && hasRenderedPages && visualPages.length > 1

  return (
    <section className="source-panel">
      <div className="panel-heading">
        <p className="eyebrow">Source data</p>
        <span>{status}</span>
      </div>

      <div className="source-tabs" role="tablist" aria-label="Source viewer modes">
        {['preview', 'text', 'layout'].map((view) => (
          <button
            key={view}
            type="button"
            className={`source-tab ${tab === view ? 'is-active' : ''}`}
            onClick={() => setTab(view)}
          >
            {view === 'preview' ? 'Preview' : view === 'text' ? 'OCR text' : 'Layout'}
          </button>
        ))}
      </div>

      <AnimatePresence>
        {showPageStepper && (
          <motion.div
            className="page-stepper"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <button type="button" onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={pageIndex === 0}>
              ← Prev
            </button>
            <span>
              Page {visualPages[pageIndex]?.page || pageIndex + 1} of {source?.pages || visualPages.length}
              {source?.pages > visualPages.length ? ` (${visualPages.length} rendered)` : ''}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.min(visualPages.length - 1, p + 1))}
              disabled={pageIndex === visualPages.length - 1}
            >
              Next →
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showZoomToolbar && (
          <ZoomToolbar
            scale={zoom.scale}
            onZoomIn={zoom.zoomIn}
            onZoomOut={zoom.zoomOut}
            onFit={zoom.fit}
            onReset={zoom.reset}
            onExpand={() => onExpand(activePageSrc, file?.name || source?.filename)}
          />
        )}
      </AnimatePresence>

      <motion.div
        key={tab}
        className="source-preview-surface"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18 }}
      >
        {renderSurface()}
      </motion.div>

      <AnimatePresence>
        {meta.length > 0 && (
          <motion.dl
            className="source-meta-grid"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            {meta.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </motion.dl>
        )}
      </AnimatePresence>
    </section>
  )
}

function Placeholder({ icon, title, detail }) {
  return (
    <div className="input-placeholder">
      <span className="input-placeholder-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}
