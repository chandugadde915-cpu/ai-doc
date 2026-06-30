"""Document extraction pipeline: OCR, PDF text, Docling, and rasterization.

Ported from lib/document-pipeline.js - same external tools (docling, pdftotext,
pdftoppm, tesseract), same extraction method names, same output shape. HEIC conversion uses
`sips` on macOS (dev) and falls back to Pillow/pillow-heif on Linux (production).
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
DOCLING_SCRIPT = WORKSPACE_ROOT / "scripts" / "docling_extract.py"
DOCLING_DEPS = WORKSPACE_ROOT / ".docling-deps"
MAX_VISUAL_PAGES = 3

TEXT_FILE_EXTENSIONS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".css",
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cpp", ".cs", ".go",
    ".rs", ".rb", ".php", ".sql", ".yaml", ".yml", ".log",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".heic"}
PDF_EXTENSION = ".pdf"
# Routed through Docling rather than a dedicated branch in run_document_pipeline, but genuinely
# supported - listed here so the API can advertise them instead of the frontend hardcoding a
# format list that can silently drift out of sync with what this pipeline actually accepts.
DOCLING_OFFICE_EXTENSIONS = {".ppt", ".pptx", ".doc", ".docx"}


def list_supported_upload_extensions() -> list[str]:
    """Single source of truth for "what can I upload" - the frontend fetches this instead of
    maintaining its own static list."""
    all_extensions = IMAGE_EXTENSIONS | {PDF_EXTENSION} | DOCLING_OFFICE_EXTENSIONS
    return sorted(ext.lstrip(".").upper() for ext in all_extensions)


@dataclass
class PipelineResult:
    extractionMethod: str
    mimeType: str
    filename: str
    pages: int
    text: str
    layout: dict[str, Any] = field(default_factory=dict)
    visualPages: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "extractionMethod": self.extractionMethod,
            "mimeType": self.mimeType,
            "filename": self.filename,
            "pages": self.pages,
            "text": self.text,
            "layout": self.layout,
            "visualPages": self.visualPages,
            "warnings": self.warnings,
        }


def run_document_pipeline(source_path: str, filename: str, mime_type: str) -> PipelineResult:
    extension = Path(filename or source_path).suffix.lower()
    mime_type = mime_type or "application/octet-stream"

    docling = _try_docling_pipeline(source_path, mime_type, filename, extension)
    if docling:
        return docling

    if extension in TEXT_FILE_EXTENSIONS or mime_type.startswith("text/"):
        return _build_text_pipeline(source_path, mime_type, filename)

    if extension == ".pdf" or mime_type == "application/pdf":
        return _build_pdf_pipeline(source_path, mime_type, filename)

    if extension in IMAGE_EXTENSIONS or mime_type.startswith("image/"):
        return _build_image_pipeline(source_path, mime_type, filename)

    return _build_binary_pipeline(mime_type, filename)


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    env = kwargs.pop("env", None)
    return subprocess.run(cmd, capture_output=True, text=kwargs.pop("text", True), env=env, **kwargs)


def _try_docling_pipeline(source_path: str, mime_type: str, filename: str, extension: str) -> PipelineResult | None:
    if not DOCLING_SCRIPT.exists():
        return None

    env = dict(os.environ)
    env["PYTHONPATH"] = f"{DOCLING_DEPS}:{env.get('PYTHONPATH', '')}" if env.get("PYTHONPATH") else str(DOCLING_DEPS)

    result = _run([sys.executable, str(DOCLING_SCRIPT), source_path], env=env)
    if result.returncode != 0:
        return None

    try:
        parsed = json.loads((result.stdout or "").strip())
    except (json.JSONDecodeError, TypeError):
        return None

    if not parsed or not parsed.get("ok"):
        return None

    text = str(parsed.get("text") or "").strip()
    layout = parsed.get("layout") or {}
    has_pages = int(parsed.get("pages") or 0) > 0
    has_content = bool(text) or _has_meaningful_docling_layout(layout)

    if not has_content and (extension == ".pdf" or extension in IMAGE_EXTENSIONS or mime_type.startswith("image/")):
        return None

    return PipelineResult(
        extractionMethod=parsed.get("extractionMethod") or "docling",
        mimeType=mime_type,
        filename=parsed.get("filename") or filename,
        pages=parsed.get("pages") or 1,
        text=text,
        layout=layout,
        visualPages=_build_visual_pages(source_path, extension, mime_type),
        warnings=[] if has_pages else ["Docling returned no page data."],
    )


def _has_meaningful_docling_layout(layout: dict[str, Any]) -> bool:
    if not isinstance(layout, dict):
        return False
    texts = layout.get("texts") or []
    tables = layout.get("tables") or []
    kv_items = layout.get("key_value_items") or []
    pages = layout.get("pages")
    pages_len = len(pages) if isinstance(pages, dict) else 0
    return bool(texts) or bool(tables) or bool(kv_items) or pages_len > 0


def _build_text_pipeline(source_path: str, mime_type: str, filename: str) -> PipelineResult:
    text = Path(source_path).read_text(encoding="utf-8", errors="replace")
    lines = [line for line in text.splitlines() if line]
    layout = {
        "pages": [{
            "pageNumber": 1,
            "blocks": [{
                "blockNumber": 1,
                "paragraphs": [{
                    "paragraphNumber": 1,
                    "bbox": None,
                    "lines": [
                        {"lineNumber": i + 1, "text": line, "bbox": None, "confidence": 1}
                        for i, line in enumerate(lines)
                    ],
                }],
            }],
        }]
    }
    return PipelineResult(extractionMethod="local-text", mimeType=mime_type, filename=filename, pages=1, text=text, layout=layout)


def _build_pdf_pipeline(source_path: str, mime_type: str, filename: str) -> PipelineResult:
    with tempfile.TemporaryDirectory(prefix="doc-pdf-") as tmp:
        tsv_path = Path(tmp) / "document.tsv"
        text_path = Path(tmp) / "document.txt"
        tsv = _run(["pdftotext", "-tsv", source_path, str(tsv_path)])
        plain = _run(["pdftotext", "-layout", "-nopgbrk", source_path, str(text_path)])
        if tsv.returncode != 0:
            raise RuntimeError(tsv.stderr or "Failed to extract PDF structure.")

        parsed = _parse_tsv(tsv_path.read_text(encoding="utf-8", errors="replace") if tsv_path.exists() else "")
        plain_text = text_path.read_text(encoding="utf-8", errors="replace") if text_path.exists() else (plain.stdout or "")
        combined_text = (parsed["text"] or plain_text or "").strip()

        if parsed["pages"] and len(combined_text) > 24:
            return PipelineResult(
                extractionMethod="pdf-text",
                mimeType=mime_type,
                filename=filename,
                pages=len(parsed["pages"]),
                text=combined_text,
                layout=parsed["layout"],
                visualPages=_build_visual_pages(source_path, ".pdf", mime_type),
            )

        return _build_raster_ocr_pipeline(source_path, mime_type, filename, "pdf-ocr")


def _build_image_pipeline(source_path: str, mime_type: str, filename: str) -> PipelineResult:
    if Path(source_path).suffix.lower() == ".heic":
        with tempfile.TemporaryDirectory(prefix="doc-heic-") as tmp:
            png_path = Path(tmp) / f"{Path(source_path).stem}.png"
            if not _convert_to_png(source_path, png_path):
                raise RuntimeError("Failed to convert HEIC image.")
            return _build_raster_ocr_pipeline(str(png_path), mime_type, filename, "heic-ocr")

    return _build_raster_ocr_pipeline(source_path, mime_type, filename, "image-ocr")


def _build_binary_pipeline(mime_type: str, filename: str) -> PipelineResult:
    return PipelineResult(
        extractionMethod="binary-metadata",
        mimeType=mime_type,
        filename=filename,
        pages=1,
        text="",
        layout={"pages": [{"pageNumber": 1, "blocks": [], "warnings": ["No text or OCR extractor matched this file type."]}]},
    )


def _build_raster_ocr_pipeline(source_path: str, mime_type: str, filename: str, extraction_method: str) -> PipelineResult:
    with tempfile.TemporaryDirectory(prefix="doc-pages-") as tmp:
        page_images = _rasterize_pdf_or_image(source_path, tmp)
        pages: list[dict[str, Any]] = []
        text_parts: list[str] = []
        warnings: list[str] = []

        cleaned_images = []
        for index, image_path in enumerate(page_images):
            cleaned_path, page_warnings = _clean_page_image(image_path, tmp, index)
            cleaned_images.append(cleaned_path)
            warnings.extend(page_warnings)

        # Vision input also benefits from the deskewed/denoised/contrast-enhanced version -
        # it's what made OCR legible, it helps the model read it too.
        visual_pages = _build_visual_pages_from_images(cleaned_images, tmp)

        for image_path in cleaned_images:
            tsv = _run(["tesseract", image_path, "stdout", "tsv"])
            parsed = _parse_tsv(tsv.stdout or "")
            if parsed["text"].strip():
                text_parts.append(parsed["text"].strip())
            if parsed["layout"]["pages"]:
                pages.append(parsed["layout"]["pages"][0])

        if not pages:
            warnings.append("OCR produced no recognized page content.")

        return PipelineResult(
            extractionMethod=extraction_method,
            mimeType=mime_type,
            filename=filename,
            pages=len(pages) or 1,
            text="\n\n".join(text_parts).strip(),
            layout={"pages": pages},
            visualPages=visual_pages,
            warnings=warnings,
        )


def _clean_page_image(image_path: str, temp_dir: str, index: int) -> tuple[str, list[str]]:
    """Run deskew/denoise/contrast/sharpen preprocessing. Falls back to the original
    image on any failure - preprocessing is a quality boost, not a hard dependency."""
    try:
        from image_preprocessing import estimate_blur_score, preprocess_for_ocr
    except ImportError:
        return image_path, []

    warnings: list[str] = []
    try:
        blur_score = estimate_blur_score(image_path)
        if 0 < blur_score < 60:
            warnings.append(f"Page {index + 1} appears blurry (sharpness score {blur_score:.0f}) - results may be less reliable.")

        cleaned_path = str(Path(temp_dir) / f"cleaned-{index}.png")
        report = preprocess_for_ocr(image_path, cleaned_path)
        if report.get("error") or not Path(cleaned_path).exists():
            return image_path, warnings
        return cleaned_path, warnings
    except Exception:
        return image_path, warnings


def _rasterize_pdf_or_image(source_path: str, temp_dir: str) -> list[str]:
    extension = Path(source_path).suffix.lower()
    if extension == ".pdf":
        prefix = Path(temp_dir) / "page"
        result = _run(["pdftoppm", "-r", "300", "-png", source_path, str(prefix)])
        if result.returncode != 0:
            raise RuntimeError(result.stderr or "Failed to rasterize PDF.")
        return _list_page_images(temp_dir)

    if extension == ".heic":
        png_path = Path(temp_dir) / f"{Path(source_path).stem}.png"
        if not _convert_to_png(source_path, png_path):
            raise RuntimeError("Failed to convert HEIC image.")
        return [str(png_path)]

    return [source_path]


def _build_visual_pages(source_path: str, extension: str, mime_type: str) -> list[dict[str, Any]]:
    if not (extension == ".pdf" or extension in IMAGE_EXTENSIONS or mime_type.startswith("image/")):
        return []
    try:
        with tempfile.TemporaryDirectory(prefix="doc-visual-") as tmp:
            page_images = _rasterize_pdf_or_image(source_path, tmp)
            return _build_visual_pages_from_images(page_images, tmp)
    except Exception:
        return []


def _build_visual_pages_from_images(page_images: list[str], temp_dir: str) -> list[dict[str, Any]]:
    results = []
    for index, image_path in enumerate(page_images[:MAX_VISUAL_PAGES]):
        image = _image_path_to_data_url(image_path, temp_dir)
        if image["dataUrl"]:
            results.append({"page": index + 1, "mimeType": image["mimeType"], "dataUrl": image["dataUrl"]})
    return results


def _image_path_to_data_url(image_path: str, temp_dir: str) -> dict[str, str]:
    extension = Path(image_path).suffix.lower()
    supported = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

    if extension in supported:
        data = Path(image_path).read_bytes()
        return {"mimeType": supported[extension], "dataUrl": f"data:{supported[extension]};base64,{base64.b64encode(data).decode()}"}

    png_path = Path(temp_dir) / f"{Path(image_path).stem}-visual.png"
    if not _convert_to_png(image_path, png_path):
        return {"mimeType": "", "dataUrl": ""}

    data = png_path.read_bytes()
    return {"mimeType": "image/png", "dataUrl": f"data:image/png;base64,{base64.b64encode(data).decode()}"}


def _convert_to_png(source_path: str, dest_path: Path) -> bool:
    """Convert any image (notably HEIC) to PNG. Prefers `sips` (fast, macOS-only - the local dev
    environment); falls back to Pillow + pillow-heif everywhere else (Linux containers like Render
    have no `sips`, so this is what production actually runs on)."""
    if shutil.which("sips"):
        result = _run(["sips", "-s", "format", "png", source_path, "--out", str(dest_path)])
        if result.returncode == 0 and dest_path.exists():
            return True

    try:
        import pillow_heif
        from PIL import Image

        pillow_heif.register_heif_opener()
        with Image.open(source_path) as img:
            img.convert("RGB").save(dest_path, format="PNG")
        return dest_path.exists()
    except Exception:
        return False


def _list_page_images(temp_dir: str) -> list[str]:
    if not os.path.isdir(temp_dir):
        return []
    names = sorted(p for p in os.listdir(temp_dir) if p.lower().endswith((".png", ".jpg", ".jpeg")))
    return [str(Path(temp_dir) / name) for name in names]


def _parse_tsv(tsv_text: str) -> dict[str, Any]:
    lines = tsv_text.strip().splitlines()
    if len(lines) <= 1:
        return {"text": "", "layout": {"pages": []}, "pages": []}

    rows = []
    for line in lines[1:]:
        cells = line.split("\t")

        def num(i: int) -> float:
            try:
                return float(cells[i]) if i < len(cells) and cells[i] != "" else 0
            except ValueError:
                return 0

        rows.append({
            "level": int(num(0)),
            "page_num": int(num(1)),
            "block_num": int(num(2)),
            "par_num": int(num(3)),
            "line_num": int(num(4)),
            "left": num(6), "top": num(7), "width": num(8), "height": num(9),
            "conf": num(10),
            "text": "\t".join(cells[11:]) if len(cells) > 11 else "",
        })

    pages: dict[int, dict] = {}
    page_order: list[int] = []
    text_parts: list[str] = []

    for row in rows:
        if row["level"] != 5 or not row["text"].strip():
            continue
        page = pages.setdefault(row["page_num"], {"pageNumber": row["page_num"], "blocks": {}, "_block_order": []})
        if row["page_num"] not in page_order:
            page_order.append(row["page_num"])

        block = page["blocks"].setdefault(row["block_num"], {"blockNumber": row["block_num"], "bbox": None, "paragraphs": {}, "_par_order": []})
        if row["block_num"] not in page["_block_order"]:
            page["_block_order"].append(row["block_num"])

        paragraph = block["paragraphs"].setdefault(row["par_num"], {"paragraphNumber": row["par_num"], "bbox": None, "lines": {}, "_line_order": []})
        if row["par_num"] not in block["_par_order"]:
            block["_par_order"].append(row["par_num"])

        line = paragraph["lines"].setdefault(row["line_num"], {"lineNumber": row["line_num"], "words": [], "text": "", "bbox": None, "confidence": 0})
        if row["line_num"] not in paragraph["_line_order"]:
            paragraph["_line_order"].append(row["line_num"])

        line["words"].append({
            "text": row["text"],
            "bbox": {"x": row["left"], "y": row["top"], "width": row["width"], "height": row["height"]},
            "confidence": row["conf"],
        })

    output_pages = []
    for page_num in page_order:
        page = pages[page_num]
        out_blocks = []
        for block_num in page["_block_order"]:
            block = page["blocks"][block_num]
            out_paragraphs = []
            for par_num in block["_par_order"]:
                paragraph = block["paragraphs"][par_num]
                out_lines = []
                for line_num in paragraph["_line_order"]:
                    line = paragraph["lines"][line_num]
                    line["text"] = " ".join(w["text"] for w in line["words"]).strip()
                    boxes = [w["bbox"] for w in line["words"] if w["bbox"]]
                    line["bbox"] = _merge_boxes(boxes)
                    confs = [w["confidence"] for w in line["words"] if isinstance(w["confidence"], (int, float))]
                    line["confidence"] = round(mean(confs)) if confs else 0
                    if line["text"]:
                        text_parts.append(line["text"])
                    out_lines.append({"lineNumber": line["lineNumber"], "text": line["text"], "bbox": line["bbox"], "confidence": line["confidence"]})
                out_paragraphs.append({"paragraphNumber": paragraph["paragraphNumber"], "bbox": paragraph["bbox"], "lines": out_lines})
            out_blocks.append({"blockNumber": block["blockNumber"], "bbox": block["bbox"], "paragraphs": out_paragraphs})
        output_pages.append({"pageNumber": page["pageNumber"], "blocks": out_blocks})

    return {"text": "\n".join(text_parts), "layout": {"pages": output_pages}, "pages": output_pages}


def _merge_boxes(boxes: list[dict[str, float]]) -> dict[str, float] | None:
    if not boxes:
        return None
    x1 = min(b["x"] for b in boxes)
    y1 = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["width"] for b in boxes)
    y2 = max(b["y"] + b["height"] for b in boxes)
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}
