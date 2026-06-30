FROM python:3.12-slim

# tesseract-ocr + poppler-utils (pdftotext/pdftoppm) are the system binaries the pipeline shells
# out to. Docling is intentionally NOT installed here - it pulls in a full PyTorch stack that
# doesn't fit Render's free-tier RAM, and the pipeline already falls back cleanly to
# pdftotext/Tesseract when Docling is unavailable (see document_pipeline.py: tryDoclingPipeline
# returns None on import failure). Add `docling` to requirements.txt and upgrade your Render plan
# if you want Docling's table/layout extraction and PPT/DOCX support.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY scripts/ scripts/

WORKDIR /app/backend

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
