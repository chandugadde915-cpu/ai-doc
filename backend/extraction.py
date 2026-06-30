"""OpenAI-backed structured extraction: model selection by file quality, plus
tiered repair/escalation for incomplete tables and key-value pairs.

Ported from server.js (callOpenAI, assessDocumentQuality, repair* functions).
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from document_pipeline import PipelineResult

OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")
OPENAI_REPAIR_MODEL = os.environ.get("OPENAI_REPAIR_MODEL", OPENAI_MODEL)
OPENAI_API_URL = "https://api.openai.com/v1/responses"

RASTER_METHODS = {"pdf-ocr", "heic-ocr", "image-ocr"}
TEXT_RICH_METHODS = {"docling", "pdf-text", "local-text"}

SYSTEM_PROMPT = """You are an expert document intelligence engine specializing in zero-error structured extraction.

Your task is to understand any uploaded document.

Never assume the document type.
First determine what the document is.
Then identify every important piece of information.
Extract all meaningful entities.
Extract every table.
Extract every key-value pair.
Generate a complete structured JSON with only extracted data.
If information does not exist, omit it.
Never hallucinate.
Never invent values.
Do not add summaries, explanations, commentary, or warnings.
Return only valid JSON.

CRITICAL TABLE RULES (most extraction errors happen here):
- Every row array MUST have exactly the same number of cells as "columns". Never return a short row.
- Read every row fully, left to right, including the rightmost columns (rate, qty, tax, amount/total). These are frequently missed - check each one explicitly before moving to the next row.
- If a line item spans a soft line-wrap in the source, merge it into one row, not two.
- If a value is genuinely blank in the source (a real empty cell), use "" - never silently drop the row or shorten it.
- Cross-check every numeric column: amount should equal qty x rate where that relationship is implied. If the rendered image and the OCR text disagree, trust the image and prefer the value that makes the row's arithmetic consistent.
- Re-scan the image at full resolution for every table before finalizing - small print in rate/amount columns is the most common miss.

CONFIDENCE RULES:
- "confidence" must reflect actual field-level certainty across entities, key_value_pairs, and especially table cell completeness, not a generic guess.
- If every table row is fully populated and cross-checked against the image, confidence should be high (0.85+).
- If any row is incomplete or guessed, confidence must be lower and that uncertainty should be reflected in that row's evidence field.

Required output shape:
{
  "document_type": "string",
  "document_category": "string",
  "language": "string",
  "pages": 0,
  "confidence": 0,
  "entities": [
    {"category": "string", "items": [{"value": "string", "evidence": "string", "page": 1}]}
  ],
  "tables": [
    {"title": "string", "page": 1, "columns": ["string"], "rows": [["string"]], "evidence": "string"}
  ],
  "key_value_pairs": [
    {"label": "string", "value": "string", "evidence": "string", "page": 1}
  ]
}"""


def assess_document_quality(pipeline: PipelineResult) -> dict[str, Any]:
    text = (pipeline.text or "").strip()
    warnings = pipeline.warnings or []
    avg_conf = _average_ocr_confidence(pipeline.layout)
    method = pipeline.extractionMethod

    if method in TEXT_RICH_METHODS and len(text) > 200 and not warnings:
        return {"tier": "high", "avgOcrConfidence": avg_conf, "reason": f"clean {method} extraction, {len(text)} chars, no warnings"}

    if method in RASTER_METHODS and (avg_conf < 75 or len(text) < 150 or warnings):
        return {"tier": "low", "avgOcrConfidence": avg_conf, "reason": f"weak OCR (avg conf {avg_conf}, {len(text)} chars, {len(warnings)} warnings)"}

    return {"tier": "medium", "avgOcrConfidence": avg_conf, "reason": f"usable but unverified {method or 'unknown'} extraction"}


def _average_ocr_confidence(layout: dict[str, Any]) -> int:
    pages = layout.get("pages") if isinstance(layout, dict) else None
    if not isinstance(pages, list):
        return 100
    values = []
    for page in pages:
        for block in page.get("blocks", []):
            for paragraph in block.get("paragraphs", []):
                for line in paragraph.get("lines", []):
                    conf = line.get("confidence")
                    if isinstance(conf, (int, float)) and conf >= 0:
                        values.append(conf)
    if not values:
        return 100
    return round(sum(values) / len(values))


def compact_layout(layout: dict[str, Any]) -> dict[str, Any]:
    if isinstance(layout, dict) and (layout.get("texts") or layout.get("tables") or layout.get("key_value_items")):
        return {"note": "Layout omitted - see document_text (markdown) for full content."}

    pages = layout.get("pages") if isinstance(layout, dict) else None
    if not isinstance(pages, list) or not pages:
        return layout or {}

    return {
        "pages": [
            {
                "pageNumber": page.get("pageNumber"),
                "lines": [
                    line.get("text")
                    for block in page.get("blocks", [])
                    for paragraph in block.get("paragraphs", [])
                    for line in paragraph.get("lines", [])
                    if line.get("text")
                ],
            }
            for page in pages
        ]
    }


async def extract_structured_data(pipeline: PipelineResult, mode: str, source_data_url: str | None, source_mime_type: str | None) -> dict[str, Any]:
    quality = assess_document_quality(pipeline)
    primary_model = OPENAI_REPAIR_MODEL if quality["tier"] == "high" else OPENAI_MODEL

    visual_pages = pipeline.visualPages or []
    should_attach_images = quality["tier"] != "high" and bool(visual_pages)

    user_payload = {
        "file": {
            "filename": pipeline.filename,
            "mimeType": pipeline.mimeType,
            "pages": pipeline.pages,
            "extractionMethod": pipeline.extractionMethod,
            "visualPages": [{"page": p["page"], "mimeType": p["mimeType"]} for p in visual_pages],
            "warnings": pipeline.warnings,
        },
        "document_text": pipeline.text,
        "layout": compact_layout(pipeline.layout),
        "mode": mode,
    }

    user_content: list[dict[str, Any]] = [
        {"type": "input_text", "text": f"Read the document intelligence payload and return the final structured JSON.\n\n{json.dumps(user_payload, indent=2)}"}
    ]

    if should_attach_images:
        user_content.append({"type": "input_text", "text": "The following page images are rendered from the uploaded document. Use them to recover text, tables, totals, dates, and fields when OCR/layout text is incomplete."})
        for page in visual_pages[:2]:
            if not page.get("dataUrl"):
                continue
            user_content.append({"type": "input_text", "text": f"Rendered page {page.get('page', 1)}"})
            user_content.append({"type": "input_image", "image_url": page["dataUrl"]})

    if not should_attach_images and not visual_pages and source_data_url and (source_mime_type or "").startswith("image/"):
        user_content.append({"type": "input_image", "image_url": source_data_url})

    parsed = await request_structured_json(SYSTEM_PROMPT, user_content, primary_model)
    models_used = {primary_model}

    incomplete_tables = find_incomplete_tables(parsed.get("tables"))
    if incomplete_tables and visual_pages:
        repaired = await repair_incomplete_tables(parsed, incomplete_tables, visual_pages, OPENAI_REPAIR_MODEL)
        if repaired is not None:
            parsed["tables"] = repaired
        models_used.add(OPENAI_REPAIR_MODEL)

        incomplete_tables = find_incomplete_tables(parsed.get("tables"))
        if incomplete_tables and OPENAI_REPAIR_MODEL != OPENAI_MODEL:
            escalated = await repair_incomplete_tables(parsed, incomplete_tables, visual_pages, OPENAI_MODEL)
            if escalated is not None:
                parsed["tables"] = escalated
            models_used.add(OPENAI_MODEL)

    if quality["tier"] != "high":
        incomplete_pairs = find_incomplete_key_value_pairs(parsed.get("key_value_pairs"))
        if incomplete_pairs and visual_pages:
            repaired = await repair_incomplete_key_value_pairs(parsed, incomplete_pairs, visual_pages, OPENAI_REPAIR_MODEL)
            if repaired is not None:
                parsed["key_value_pairs"] = repaired
            models_used.add(OPENAI_REPAIR_MODEL)

            incomplete_pairs = find_incomplete_key_value_pairs(parsed.get("key_value_pairs"))
            if incomplete_pairs and OPENAI_REPAIR_MODEL != OPENAI_MODEL:
                escalated = await repair_incomplete_key_value_pairs(parsed, incomplete_pairs, visual_pages, OPENAI_MODEL)
                if escalated is not None:
                    parsed["key_value_pairs"] = escalated
                models_used.add(OPENAI_MODEL)

    parsed["__quality"] = {"tier": quality["tier"], "reason": quality["reason"], "modelsUsed": sorted(models_used)}
    return parsed


async def request_structured_json(system_prompt: str, user_content: list[dict[str, Any]], model: str) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            OPENAI_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "input": [
                    {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                    {"role": "user", "content": user_content},
                ],
            },
        )

    payload = response.json() if response.content else {}
    if response.status_code >= 400:
        message = (payload.get("error") or {}).get("message") or f"OpenAI request failed with status {response.status_code}"
        raise RuntimeError(message)

    text = payload.get("output_text") or _extract_output_text(payload)
    parsed = _safe_parse_json(text)
    if parsed is None:
        raise RuntimeError("OpenAI returned an unparseable response.")
    return parsed


def _extract_output_text(payload: dict[str, Any]) -> str:
    chunks = []
    for item in payload.get("output", []):
        for part in item.get("content", []):
            if part.get("type") == "output_text" and part.get("text"):
                chunks.append(part["text"])
    return "\n".join(chunks).strip()


def _safe_parse_json(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}$", text)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


def find_incomplete_tables(tables: Any) -> list[int]:
    if not isinstance(tables, list):
        return []
    indexes = []
    for index, table in enumerate(tables):
        columns = table.get("columns") if isinstance(table, dict) else None
        rows = table.get("rows") if isinstance(table, dict) else None
        if not isinstance(columns, list) or not columns or not isinstance(rows, list) or not rows:
            continue
        incomplete = False
        for row in rows:
            cells = row if isinstance(row, list) else [row]
            if len(cells) != len(columns):
                incomplete = True
                break
            blanks = sum(1 for cell in cells if str(cell or "").strip() == "")
            if blanks / len(cells) > 0.3:
                incomplete = True
                break
        if incomplete:
            indexes.append(index)
    return indexes


async def repair_incomplete_tables(parsed: dict[str, Any], incomplete_indexes: list[int], visual_pages: list[dict[str, Any]], model: str) -> list[Any] | None:
    tables_to_fix = [{"index": i, "table": parsed["tables"][i]} for i in incomplete_indexes]

    repair_prompt = """You are correcting incomplete tables extracted from a document.

You will be given the page images and a JSON list of tables that have missing or short rows.
Re-read every row directly from the image, cell by cell, including small print in rate/qty/tax/amount columns.
Return ONLY a JSON object: { "tables": [ { "index": 0, "columns": ["string"], "rows": [["string"]] } ] }
Every row array must have exactly the same length as "columns". Use "" only for cells that are genuinely blank in the source. Never shorten or omit a row."""

    repair_content: list[dict[str, Any]] = [{"type": "input_text", "text": f"Tables that need correction:\n{json.dumps(tables_to_fix, indent=2)}"}]

    needed_pages = {t["table"].get("page") for t in tables_to_fix if t["table"].get("page")}
    pages_to_send = [p for p in visual_pages if p["page"] in needed_pages] if needed_pages else visual_pages[:2]

    for page in pages_to_send:
        if not page.get("dataUrl"):
            continue
        repair_content.append({"type": "input_text", "text": f"Rendered page {page.get('page', 1)}"})
        repair_content.append({"type": "input_image", "image_url": page["dataUrl"]})

    try:
        result = await request_structured_json(repair_prompt, repair_content, model)
        fixed_tables = result.get("tables") if isinstance(result.get("tables"), list) else []
        updated = list(parsed["tables"])
        for fixed in fixed_tables:
            index = fixed.get("index")
            if not isinstance(index, int) or index >= len(updated):
                continue
            updated[index] = {
                **updated[index],
                "columns": fixed.get("columns") if isinstance(fixed.get("columns"), list) else updated[index].get("columns"),
                "rows": fixed.get("rows") if isinstance(fixed.get("rows"), list) else updated[index].get("rows"),
            }
        return updated
    except Exception:
        return None


def find_incomplete_key_value_pairs(pairs: Any) -> list[int]:
    if not isinstance(pairs, list):
        return []
    indexes = []
    for index, pair in enumerate(pairs):
        if not isinstance(pair, dict):
            continue
        value = str(pair.get("value") or "").strip()
        label = str(pair.get("label") or "").strip()
        if label and not value:
            indexes.append(index)
    return indexes


async def repair_incomplete_key_value_pairs(parsed: dict[str, Any], incomplete_indexes: list[int], visual_pages: list[dict[str, Any]], model: str) -> list[Any] | None:
    pairs_to_fix = [{"index": i, "pair": parsed["key_value_pairs"][i]} for i in incomplete_indexes]

    repair_prompt = """You are correcting incomplete key-value pairs extracted from a document.

You will be given the page images and a JSON list of labels whose values were missed.
Re-read the document image directly to find the value for each labeled field. If it genuinely does not appear anywhere in the document, leave it as "".
Return ONLY a JSON object: { "key_value_pairs": [ { "index": 0, "value": "string" } ] }"""

    repair_content: list[dict[str, Any]] = [{"type": "input_text", "text": f"Key-value pairs that need correction:\n{json.dumps(pairs_to_fix, indent=2)}"}]

    needed_pages = {p["pair"].get("page") for p in pairs_to_fix if p["pair"].get("page")}
    pages_to_send = [p for p in visual_pages if p["page"] in needed_pages] if needed_pages else visual_pages[:2]

    for page in pages_to_send:
        if not page.get("dataUrl"):
            continue
        repair_content.append({"type": "input_text", "text": f"Rendered page {page.get('page', 1)}"})
        repair_content.append({"type": "input_image", "image_url": page["dataUrl"]})

    try:
        result = await request_structured_json(repair_prompt, repair_content, model)
        fixed_pairs = result.get("key_value_pairs") if isinstance(result.get("key_value_pairs"), list) else []
        updated = list(parsed["key_value_pairs"])
        for fixed in fixed_pairs:
            index = fixed.get("index")
            if not isinstance(index, int) or index >= len(updated):
                continue
            updated[index] = {**updated[index], "value": fixed.get("value", updated[index].get("value"))}
        return updated
    except Exception:
        return None
