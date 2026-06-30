from __future__ import annotations

import base64
import os
import re
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(WORKSPACE_ROOT / ".env")

from document_pipeline import list_supported_upload_extensions, run_document_pipeline  # noqa: E402
from extraction import OPENAI_MODEL, OPENAI_REPAIR_MODEL, extract_structured_data  # noqa: E402
from scoring import compute_extraction_quality, derive_review_status  # noqa: E402

MAX_UPLOAD_BYTES = 50 * 1024 * 1024

app = FastAPI(title="AI Document Intelligence")

def _parse_cors_origins(raw: str) -> list[str]:
    # Strip whitespace and trailing slashes per entry - "https://a.com, https://b.com/" with a
    # stray space or trailing slash silently fails to match the browser's Origin header otherwise,
    # which is indistinguishable from "not set" when debugging from the outside.
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_cors_origins(os.environ.get("CORS_ORIGINS", "http://localhost:5173")),
    allow_origin_regex=r"https://.*\.vercel\.app",  # covers Vercel preview-deployment URLs too
    allow_methods=["*"],
    allow_headers=["*"],
)


def sanitize_filename(name: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9._-]", "_", name or "upload.bin")
    return base[-180:] or "upload.bin"


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "model": OPENAI_MODEL,
        "repairModel": OPENAI_REPAIR_MODEL,
        "hasApiKey": bool(os.environ.get("OPENAI_API_KEY")),
        "supportedFormats": list_supported_upload_extensions(),
        "maxUploadBytes": MAX_UPLOAD_BYTES,
    }


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), mode: str = Form("analysis")):
    if not os.environ.get("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="Create a .env file from .env.example, add your OpenAI key, and restart the server.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="No file was uploaded.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (50MB limit).")

    mime_type = file.content_type or "application/octet-stream"
    source_name = sanitize_filename(file.filename or "upload.bin")

    with tempfile.TemporaryDirectory(prefix="doc-intel-") as tmp_dir:
        source_path = str(Path(tmp_dir) / source_name)
        Path(source_path).write_bytes(data)
        source_data_url = f"data:{mime_type};base64,{base64.b64encode(data).decode()}"

        try:
            pipeline = run_document_pipeline(source_path, file.filename or source_name, mime_type)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Document extraction failed: {exc}") from exc

        try:
            model_result = await extract_structured_data(pipeline, mode, source_data_url, mime_type)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Model extraction failed: {exc}") from exc

        quality_info = model_result.pop("__quality", {"tier": "unknown", "reason": "", "modelsUsed": []})
        extraction_quality = compute_extraction_quality(pipeline, model_result)
        review_status = derive_review_status(extraction_quality, model_result.get("confidence"))

        return {
            **model_result,
            "extraction_quality": extraction_quality,
            "review_status": review_status,
            "processing": {
                "quality_tier": quality_info.get("tier"),
                "quality_reason": quality_info.get("reason"),
                "models_used": quality_info.get("modelsUsed"),
            },
            "source": {
                "filename": file.filename,
                "mimeType": mime_type,
                "size": len(data),
                "extractionMethod": pipeline.extractionMethod,
                "pages": pipeline.pages,
                "text": pipeline.text,
                "layout": pipeline.layout,
                "visualPages": pipeline.visualPages,
                "warnings": pipeline.warnings,
            },
        }
