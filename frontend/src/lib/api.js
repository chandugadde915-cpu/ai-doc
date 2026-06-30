// In dev, requests to /api/* are proxied to the local backend (see vite.config.js). In
// production (e.g. Vercel), the frontend and backend are different origins, so VITE_API_BASE_URL
// must point at the deployed backend (e.g. https://your-app.onrender.com). Falls back to a
// same-origin relative path if unset, which only works when both are served from one origin.
const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') || ''

export async function fetchHealth() {
  const response = await fetch(`${API_BASE}/api/health`)
  if (!response.ok) throw new Error('Backend unavailable')
  return response.json()
}

export async function analyzeDocument(file, mode = 'analysis') {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('mode', mode)

  const response = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', body: formData })
  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'The analysis request failed.')
  }

  return payload
}
