import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import DropZone from './components/DropZone'
import FileList from './components/FileList'
import SourcePanel from './components/SourcePanel'
import ResultPanel from './components/ResultPanel'
import Lightbox from './components/Lightbox'
import { analyzeDocument, fetchHealth } from './lib/api'
import { deepClone, setByPath } from './lib/dataUtils'

let nextId = 1

function isPreviewable(file) {
  return file.type?.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
}

function makeDocument(file) {
  return {
    id: nextId++,
    file,
    previewUrl: isPreviewable(file) ? URL.createObjectURL(file) : '',
    status: 'idle', // idle | loading | success | error
    error: '',
    originalPayload: null,
    editedPayload: null,
    editedPaths: new Set(),
  }
}

export default function App() {
  const [documents, setDocuments] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [health, setHealth] = useState(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [lightbox, setLightbox] = useState({ src: '', filename: '' })
  const resultPanelRef = useRef(null)

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false }))
  }, [])

  useEffect(() => {
    return () => {
      documents.forEach((doc) => doc.previewUrl && URL.revokeObjectURL(doc.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeDoc = documents.find((doc) => doc.id === activeId) || null

  const updateDoc = (id, patch) => {
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, ...(typeof patch === 'function' ? patch(doc) : patch) } : doc)))
  }

  const handleFilesSelected = (files) => {
    const newDocs = files.map(makeDocument)
    setDocuments((prev) => [...prev, ...newDocs])
    setActiveId(newDocs[0].id)
  }

  const handleRemoveDoc = (id) => {
    setDocuments((prev) => {
      const target = prev.find((doc) => doc.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((doc) => doc.id !== id)
    })
    setActiveId((current) => (current === id ? null : current))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!documents.length || isAnalyzing) return

    setIsAnalyzing(true)
    for (const doc of documents) {
      if (doc.status === 'success') continue
      updateDoc(doc.id, { status: 'loading', error: '' })
      try {
        const payload = await analyzeDocument(doc.file)
        updateDoc(doc.id, {
          status: 'success',
          originalPayload: deepClone(payload),
          editedPayload: deepClone(payload),
          editedPaths: new Set(),
        })
      } catch (error) {
        updateDoc(doc.id, { status: 'error', error: error.message })
      }
    }
    setIsAnalyzing(false)
    requestAnimationFrame(() => {
      resultPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  const handleEdit = (id, path, value) => {
    updateDoc(id, (doc) => {
      const next = deepClone(doc.editedPayload)
      setByPath(next, path, value)
      const paths = new Set(doc.editedPaths)
      paths.add(path)
      return { editedPayload: next, editedPaths: paths }
    })
  }

  const handleResetEdits = (id) => {
    updateDoc(id, (doc) => (doc.originalPayload ? { editedPayload: deepClone(doc.originalPayload), editedPaths: new Set() } : doc))
  }

  const handleCopyJson = async (id) => {
    const doc = documents.find((d) => d.id === id)
    if (!doc?.editedPayload) return
    await navigator.clipboard.writeText(JSON.stringify(doc.editedPayload, null, 2))
  }

  const handleDownloadJson = (id) => {
    const doc = documents.find((d) => d.id === id)
    if (!doc?.editedPayload) return
    const blob = new Blob([JSON.stringify(doc.editedPayload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(doc.editedPayload.document_type || 'document').toLowerCase().replace(/\s+/g, '-')}-corrected.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const sourceForPreview = activeDoc?.status === 'success' ? activeDoc.editedPayload?.source : null
  const pendingCount = documents.filter((d) => d.status === 'idle' || d.status === 'error').length

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="AI Document Intelligence">
        <aside className="side-panel">
          <div>
            <p className="eyebrow">AI Document Intelligence</p>
            <h1>Input</h1>
            <p className="intro">Upload one or more documents and the system will OCR each one, read its layout, classify it dynamically, and return structured JSON.</p>
          </div>

          <form className="upload-form" onSubmit={handleSubmit}>
            <DropZone
              onFilesSelected={handleFilesSelected}
              formats={health?.supportedFormats}
              maxUploadBytes={health?.maxUploadBytes}
            />

            <FileList documents={documents} activeId={activeId} onSelect={setActiveId} onRemove={handleRemoveDoc} />

            <AnimatePresence>
              {documents.length > 0 && (
                <motion.button
                  className="primary-button"
                  type="submit"
                  disabled={isAnalyzing || pendingCount === 0}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  whileHover={{ scale: isAnalyzing ? 1 : 1.015 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <span className="button-icon" aria-hidden="true">
                    {isAnalyzing ? '...' : '→'}
                  </span>
                  {isAnalyzing
                    ? 'Analyzing'
                    : pendingCount === 0
                      ? 'All files analyzed'
                      : `Analyze ${pendingCount} document${pendingCount > 1 ? 's' : ''}`}
                </motion.button>
              )}
            </AnimatePresence>
          </form>

          <SourcePanel
            file={activeDoc?.file}
            previewUrl={activeDoc?.previewUrl}
            source={sourceForPreview}
            onExpand={(src, filename) => setLightbox({ src, filename })}
          />

          <div className="status-strip">
            <span className={`status-dot ${health == null ? '' : health.hasApiKey ? 'ok' : 'bad'}`} />
            <span>
              {health == null
                ? 'Checking backend...'
                : health.hasApiKey
                  ? `Backend ready using ${health.model}`
                  : 'Backend ready, API key missing'}
            </span>
          </div>
        </aside>

        <section className="result-panel" ref={resultPanelRef}>
          {documents.length === 0 ? (
            <motion.div key="empty" className="empty-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <div className="empty-mark" aria-hidden="true">
                AI
              </div>
              <h2>Output</h2>
              <p>The model result will appear here as structured data, entities, key-value pairs, and tables - one section per uploaded file.</p>
            </motion.div>
          ) : (
            <div className="result-feed">
              <AnimatePresence initial={false}>
                {documents.map((doc) => (
                  <motion.div
                    key={doc.id}
                    layout
                    className={`result-doc ${doc.id === activeId ? 'is-active' : ''}`}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <button type="button" className="result-doc-header" onClick={() => setActiveId(doc.id)}>
                      <span
                        className={`file-list-dot ${doc.status === 'success' ? 'ok' : doc.status === 'error' ? 'bad' : 'pending'}`}
                        aria-hidden="true"
                      />
                      <strong>{doc.file.name}</strong>
                      {doc.status === 'success' && (
                        <span className="result-doc-accuracy">Accuracy {Math.round((doc.editedPayload?.confidence ?? 0) * 100)}%</span>
                      )}
                    </button>

                    {doc.status === 'idle' && <p className="result-doc-hint">Not analyzed yet.</p>}

                    {doc.status === 'loading' && (
                      <div className="loading-state loading-state-inline">
                        <motion.div className="loader" animate={{ rotate: 360 }} transition={{ repeat: Infinity, ease: 'linear', duration: 0.85 }} />
                        <p>Running OCR, building layout data, and sending the payload to the model.</p>
                      </div>
                    )}

                    {doc.status === 'error' && (
                      <div className="error-state" role="alert">
                        {doc.error}
                      </div>
                    )}

                    {doc.status === 'success' && doc.editedPayload && (
                      <ResultPanel
                        payload={doc.editedPayload}
                        isDirty={doc.editedPaths.size > 0}
                        editedPaths={doc.editedPaths}
                        onEdit={(path, value) => handleEdit(doc.id, path, value)}
                        onReset={() => handleResetEdits(doc.id)}
                        onCopy={() => handleCopyJson(doc.id)}
                        onDownload={() => handleDownloadJson(doc.id)}
                      />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>
      </section>

      <Lightbox src={lightbox.src} filename={lightbox.filename} onClose={() => setLightbox({ src: '', filename: '' })} />
    </main>
  )
}
