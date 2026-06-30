import { useState } from 'react'
import EditableSpan from './EditableSpan'
import { valueKind } from '../lib/displayUtils'

export default function FieldValue({ value, edited, verified, onCommit, onToggleVerify }) {
  const [justCopied, setJustCopied] = useState(false)
  const kind = valueKind(value)

  const handleCopy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(String(value ?? ''))
      setJustCopied(true)
      setTimeout(() => setJustCopied(false), 1200)
    } catch {
      // clipboard unavailable - no-op
    }
  }

  return (
    <div className={`field-value field-value-${kind}`}>
      <EditableSpan value={value} edited={edited} onCommit={onCommit} className="field-value-text" />
      <div className="field-actions">
        <button type="button" className="field-action-btn" title="Copy value" onClick={handleCopy}>
          {justCopied ? '✓' : '⧉'}
        </button>
        <button
          type="button"
          className={`field-action-btn ${verified ? 'is-verified' : ''}`}
          title={verified ? 'Marked as verified' : 'Mark as verified'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleVerify()
          }}
        >
          {verified ? '✔' : '○'}
        </button>
      </div>
    </div>
  )
}
