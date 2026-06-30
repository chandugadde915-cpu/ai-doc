"""Extraction quality / review-status scoring, ported from server.js."""
from __future__ import annotations

from typing import Any

from document_pipeline import PipelineResult

METHOD_WEIGHTS = {
    "docling": 0.28,
    "pdf-text": 0.24,
    "local-text": 0.23,
    "pdf-ocr": 0.18,
    "heic-ocr": 0.18,
    "image-ocr": 0.18,
    "binary-metadata": 0.05,
}


def clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def normalize_fraction(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    if numeric > 1:
        return clamp(numeric / 100, 0, 1)
    return clamp(numeric, 0, 1)


def score_evidence_coverage(entities: list, key_value_pairs: list, tables: list) -> float:
    total = 0.0
    filled = 0.0

    for entry in entities:
        items = entry.get("items") if isinstance(entry, dict) else None
        for item in items or []:
            total += 1
            if str((item or {}).get("value") or "").strip():
                filled += 1
            if str((item or {}).get("evidence") or "").strip():
                filled += 0.25

    for item in key_value_pairs:
        total += 1
        if str((item or {}).get("value") or "").strip():
            filled += 1
        if str((item or {}).get("evidence") or "").strip():
            filled += 0.25

    for table in tables:
        rows = (table or {}).get("rows") if isinstance(table, dict) else None
        total += 1
        if rows:
            filled += 1
        if isinstance((table or {}).get("columns"), list) and table["columns"]:
            filled += 0.5

    if not total:
        return 0.0
    return filled / (total * 1.25)


def compute_extraction_quality(pipeline: PipelineResult, model_result: dict[str, Any]) -> float:
    text = (pipeline.text or "").strip()
    pages = pipeline.pages or 0
    entities = model_result.get("entities") if isinstance(model_result.get("entities"), list) else []
    key_value_pairs = model_result.get("key_value_pairs") if isinstance(model_result.get("key_value_pairs"), list) else []
    tables = model_result.get("tables") if isinstance(model_result.get("tables"), list) else []
    warnings = pipeline.warnings or []
    visual_pages = pipeline.visualPages or []
    confidence = normalize_fraction(model_result.get("confidence"))

    method_score = METHOD_WEIGHTS.get(pipeline.extractionMethod, 0.14)
    text_score = clamp(len(text) / 2600, 0, 1) * 0.24
    page_score = clamp(pages / 8, 0, 1) * 0.1
    structure_score = clamp((len(entities) + len(key_value_pairs) + len(tables)) / 12, 0, 1) * 0.2
    evidence_score = clamp(score_evidence_coverage(entities, key_value_pairs, tables), 0, 1) * 0.12
    visual_score = clamp(len(visual_pages) / 3, 0, 1) * 0.12
    confidence_score = confidence * 0.18
    warning_penalty = clamp(len(warnings) * 0.03, 0, 0.12)
    empty_penalty = 0 if (text or visual_pages) else 0.12

    score = (
        method_score + text_score + page_score + structure_score + evidence_score
        + visual_score + confidence_score - warning_penalty - empty_penalty
    )
    return round(clamp(score, 0.04, 0.98) * 100) / 100


def derive_review_status(extraction_quality: float, confidence: Any) -> str:
    quality = normalize_fraction(extraction_quality)
    confidence_score = normalize_fraction(confidence)
    blended = quality * 0.65 + confidence_score * 0.35

    if blended >= 0.8:
        return "Ready for review"
    if blended >= 0.55:
        return "Review recommended"
    return "Needs human review"
