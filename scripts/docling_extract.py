#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from docling.document_converter import DocumentConverter


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing source path"}))
        return 2

    source = Path(sys.argv[1])
    converter = DocumentConverter()
    result = converter.convert(source)
    document = result.document
    doc_dict = document.export_to_dict()
    markdown = document.export_to_markdown()
    pages = len(getattr(result, "pages", []) or [])
    if pages <= 0:
        pages = len(doc_dict.get("pages", {}) or []) or 1

    payload = {
        "ok": True,
        "extractionMethod": "docling",
        "filename": result.input.filename if hasattr(result.input, "filename") else source.name,
        "pages": pages,
        "text": markdown.strip(),
        "layout": doc_dict,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
