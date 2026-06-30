import { useCallback, useRef, useState } from 'react'

export function useZoomPan() {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragState = useRef({ dragging: false, lastX: 0, lastY: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const viewportRef = useRef(null)
  const imageRef = useRef(null)

  const onWheel = useCallback((event) => {
    event.preventDefault()
    const delta = event.deltaY > 0 ? -0.15 : 0.15
    setScale((prev) => Math.min(6, Math.max(0.15, prev + delta)))
  }, [])

  const onMouseDown = useCallback((event) => {
    dragState.current = { dragging: true, lastX: event.clientX, lastY: event.clientY }
    setIsDragging(true)
  }, [])

  const onMouseMove = useCallback((event) => {
    if (!dragState.current.dragging) return
    const dx = event.clientX - dragState.current.lastX
    const dy = event.clientY - dragState.current.lastY
    dragState.current.lastX = event.clientX
    dragState.current.lastY = event.clientY
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
  }, [])

  const onMouseUp = useCallback(() => {
    dragState.current.dragging = false
    setIsDragging(false)
  }, [])

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const fit = useCallback(() => {
    const img = imageRef.current
    const viewport = viewportRef.current
    if (!img || !viewport || !img.naturalWidth) return
    const rect = viewport.getBoundingClientRect()
    const nextScale = Math.min((rect.width - 32) / img.naturalWidth, (rect.height - 32) / img.naturalHeight, 1)
    const finalScale = Math.max(0.1, nextScale)
    setScale(finalScale)
    setOffset({
      x: (rect.width - img.naturalWidth * finalScale) / 2,
      y: (rect.height - img.naturalHeight * finalScale) / 2,
    })
  }, [])

  return {
    scale,
    offset,
    isDragging,
    viewportRef,
    imageRef,
    setZoom: (value) => setScale(Math.min(6, Math.max(0.15, value))),
    zoomIn: () => setScale((prev) => Math.min(6, prev + 0.25)),
    zoomOut: () => setScale((prev) => Math.max(0.15, prev - 0.25)),
    reset,
    fit,
    handlers: { onWheel, onMouseDown, onMouseMove, onMouseUp },
  }
}
