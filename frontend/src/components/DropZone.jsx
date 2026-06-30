import { motion } from 'framer-motion'
import { useRef, useState } from 'react'
import { formatBytes } from '../lib/dataUtils'

export default function DropZone({ onFilesSelected, formats, maxUploadBytes }) {
  const inputRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (files.length) onFilesSelected(files)
  }

  // Accept whatever the backend actually supports - until that loads, leave it unrestricted
  // rather than guessing, since the upload is validated server-side regardless.
  const accept = formats?.length ? formats.map((f) => `.${f.toLowerCase()}`).join(',') : undefined

  return (
    <motion.label
      className={`drop-zone ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.99 }}
      animate={isDragging ? { scale: 1.015 } : { scale: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 22 }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <motion.span
        className="drop-icon"
        aria-hidden="true"
        animate={isDragging ? { y: -3, scale: 1.08 } : { y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
      >
        ↑
      </motion.span>
      <span className="drop-title">Drop files here or click to browse</span>
      <span className="drop-detail">
        Multiple images, scans, and documents supported{maxUploadBytes ? ` · up to ${formatBytes(maxUploadBytes)} each` : ''}
      </span>
      {formats?.length > 0 && (
        <span className="drop-formats">
          {formats.map((format) => (
            <span className="format-chip" key={format}>
              {format}
            </span>
          ))}
        </span>
      )}
    </motion.label>
  )
}
