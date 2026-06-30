import { AnimatePresence, motion } from 'framer-motion'
import { formatBytes, getExtension } from '../lib/dataUtils'

const STATUS_LABEL = {
  idle: 'Ready to analyze',
  loading: 'Analyzing...',
  success: 'Done',
  error: 'Failed',
}

export default function FileList({ documents, activeId, onSelect, onRemove }) {
  if (!documents.length) return null

  return (
    <div className="file-list">
      <div className="file-list-heading">
        <p className="eyebrow">Uploaded files</p>
        <span>{documents.length} file{documents.length > 1 ? 's' : ''}</span>
      </div>
      <ul className="file-list-items">
        <AnimatePresence initial={false}>
          {documents.map((doc) => (
            <motion.li
              key={doc.id}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              className={`file-list-item status-${doc.status} ${doc.id === activeId ? 'is-active' : ''}`}
              onClick={() => onSelect(doc.id)}
            >
              <span className="file-list-badge">{getExtension(doc.file.name).slice(0, 4) || 'file'}</span>
              <span className="file-list-info">
                <strong>{doc.file.name}</strong>
                <span className="file-list-meta">
                  {formatBytes(doc.file.size)} · {STATUS_LABEL[doc.status]}
                  {doc.status === 'success' && doc.payload
                    ? ` · Accuracy ${Math.round((doc.payload.confidence ?? 0) * 100)}%`
                    : ''}
                </span>
              </span>
              {doc.status === 'loading' && <span className="file-list-spinner" aria-hidden="true" />}
              {doc.status === 'success' && <span className="file-list-dot ok" aria-hidden="true" />}
              {doc.status === 'error' && <span className="file-list-dot bad" aria-hidden="true" />}
              <button
                type="button"
                className="file-list-remove"
                title="Remove file"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(doc.id)
                }}
              >
                ✕
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  )
}
