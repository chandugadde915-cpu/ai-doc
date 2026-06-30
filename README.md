# AI Document Intelligence

A document intelligence platform that OCRs uploads, preserves layout metadata, sends the extracted content to GPT-5.5 through the OpenAI Responses API, and renders the result as structured, editable JSON.

**Stack:** React (Vite) frontend + FastAPI (Python) backend. The original single-process Node/vanilla-JS version (`server.js`, `public/`) is kept in the repo for reference but is no longer the primary app.

## Run

1. Copy `.env.example` to `.env` and add your OpenAI key:

```bash
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-5.5
OPENAI_REPAIR_MODEL=gpt-5.4-mini   # cheaper model used for table/field repair passes
```

2. Start the backend (FastAPI):

```bash
cd backend
pip install -r requirements.txt
python3 -m uvicorn main:app --reload --port 8000
```

3. Start the frontend (React/Vite) in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

4. Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to the FastAPI backend on port 8000 (see `frontend/vite.config.js`).

## Deploying (Vercel + Render)

Vercel only runs serverless Node/edge functions - it can't run the backend, which shells out to
`tesseract`/`pdftotext`/`pdftoppm` and needs longer execution windows than serverless functions
allow. So: **frontend on Vercel, backend on Render** (or any host that runs a long-lived Docker
container - Railway, Fly.io, a VPS all work the same way).

### 1. Backend → Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` at the repo root configures
   the service (Docker build from `backend/Dockerfile`).
3. Set environment variables on the Render service:
   - `OPENAI_API_KEY` (required)
   - `OPENAI_MODEL` / `OPENAI_REPAIR_MODEL` (already defaulted in `render.yaml`)
   - `CORS_ORIGINS` → your Vercel frontend URL once you have it (comma-separated if multiple, e.g.
     preview + production URLs)
4. Note the resulting backend URL (`https://<service>.onrender.com`).

**Docling is intentionally not installed** in the Docker image - it pulls in a full PyTorch stack
that won't fit Render's free-tier RAM. The pipeline already falls back cleanly to
`pdftotext`/Tesseract when Docling is unavailable, so the app stays fully functional; you just lose
Docling's table/layout boost and PPT/DOCX support. Add `docling` to `backend/requirements.txt` and
upgrade your Render plan if you need that back.

### 2. Frontend → Vercel

1. Import the repo into Vercel. `vercel.json` at the repo root tells it to build from `frontend/`.
2. Set the environment variable `VITE_API_BASE_URL` to your Render backend URL from step 1.
3. Deploy. The frontend will call `${VITE_API_BASE_URL}/api/*` instead of the dev-only relative
   proxy path.

### 3. Connect them

Go back to Render and set `CORS_ORIGINS` to your final Vercel URL (e.g.
`https://your-app.vercel.app`), then redeploy the backend so it accepts requests from it.

## Architecture

- `backend/document_pipeline.py` — OCR/text extraction (Docling, `pdftotext`, `pdftoppm` + `tesseract`; HEIC conversion via `sips` on macOS dev, Pillow/pillow-heif on Linux/production).
- `backend/extraction.py` — OpenAI calls, adaptive model selection by file quality, tiered repair/escalation for incomplete tables and key-value pairs.
- `backend/scoring.py` — extraction-quality and review-status heuristics.
- `backend/main.py` — FastAPI app (`/api/health`, `/api/analyze`).
- `frontend/src/` — React UI: drag-and-drop upload, zoomable/pannable document preview with fullscreen lightbox, editable extraction results grouped by page, animated transitions (Framer Motion).

## Notes

- OCR uses local system tools first; Docling is tried before falling back to `pdftotext`/Tesseract.
- File quality (clean digital text vs. OCR'd/blurry scans) determines which OpenAI model handles extraction and whether page images are sent at all, keeping cost down without sacrificing accuracy on the documents that need it.
- Incomplete tables and key-value pairs go through a cheap-model-first, strong-model-escalation repair pass.
- The response is document-agnostic and does not rely on document-specific templates or field rules.
