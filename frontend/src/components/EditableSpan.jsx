export default function EditableSpan({ value, onCommit, edited, className = '' }) {
  const handleBlur = (event) => {
    onCommit(event.currentTarget.textContent.trim())
  }
  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  return (
    <span
      className={`editable-field ${edited ? 'is-edited' : ''} ${className}`}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {value}
    </span>
  )
}
