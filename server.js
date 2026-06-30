import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runDocumentPipeline } from "./lib/document-pipeline.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
// The repair pass is a narrow, well-constrained correction task (fix specific incomplete table rows
// given a crop of pages) - it doesn't need the same model strength as full document understanding,
// so it can run on a cheaper/faster model by default while keeping primary extraction quality untouched.
const OPENAI_REPAIR_MODEL = process.env.OPENAI_REPAIR_MODEL || OPENAI_MODEL;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/analyze") {
      await handleAnalyze(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        model: OPENAI_MODEL,
        repairModel: OPENAI_REPAIR_MODEL,
        hasApiKey: Boolean(process.env.OPENAI_API_KEY)
      });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Something went wrong on the server.", detail: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Document Intelligence running at http://${HOST}:${PORT}`);
});

async function handleAnalyze(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "Missing OPENAI_API_KEY",
      detail: "Create a .env file from .env.example, add your key, and restart the server."
    });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 400, { error: "Please upload a file using multipart/form-data." });
    return;
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  const { fields, files } = parseMultipart(body, contentType);
  const file = files.file;

  if (!file || !file.data?.length) {
    sendJson(res, 400, { error: "No file was uploaded." });
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "doc-intel-"));
  const sourceName = sanitizeFileName(file.filename || "upload.bin");
  const sourcePath = join(tempDir, sourceName);
  writeFileSync(sourcePath, file.data);
  const sourceDataUrl = `data:${file.contentType || "application/octet-stream"};base64,${file.data.toString("base64")}`;

  try {
    const pipeline = runDocumentPipeline(sourcePath, {
      filename: file.filename,
      mimeType: file.contentType || "application/octet-stream"
    });
    const modelResult = await callOpenAI(pipeline, fields.mode || "analysis", {
      sourceDataUrl,
      sourceMimeType: file.contentType || "application/octet-stream"
    });
    const qualityInfo = modelResult.__quality || { tier: "unknown", reason: "", modelsUsed: [] };
    delete modelResult.__quality;
    const extractionQuality = computeExtractionQuality(pipeline, modelResult);
    const reviewStatus = deriveReviewStatus(extractionQuality, modelResult?.confidence);

    sendJson(res, 200, {
      ...modelResult,
      extraction_quality: extractionQuality,
      review_status: reviewStatus,
      processing: {
        quality_tier: qualityInfo.tier,
        quality_reason: qualityInfo.reason,
        models_used: qualityInfo.modelsUsed
      },
      source: {
        filename: file.filename,
        mimeType: file.contentType || "application/octet-stream",
        size: file.data.length,
        extractionMethod: pipeline.extractionMethod,
        pages: pipeline.pages,
        text: pipeline.text,
        layout: pipeline.layout,
        visualPages: pipeline.visualPages || [],
        warnings: pipeline.warnings || []
      }
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// File quality drives both model selection and how hard the repair/escalation chain works.
// Clean, deterministically-extracted text (docling/pdf-text) doesn't need a top-tier model to
// structure it correctly, so it runs on the cheap model. Anything OCR'd or visually noisy gets the
// strong model up front plus a wider safety net, since that's where real accuracy risk lives.
const RASTER_METHODS = new Set(["pdf-ocr", "heic-ocr", "image-ocr"]);
const TEXT_RICH_METHODS = new Set(["docling", "pdf-text", "local-text"]);

function assessDocumentQuality(pipeline) {
  const text = String(pipeline?.text || "").trim();
  const warnings = Array.isArray(pipeline?.warnings) ? pipeline.warnings : [];
  const avgOcrConfidence = averageOcrConfidence(pipeline?.layout);
  const method = pipeline?.extractionMethod;

  if (TEXT_RICH_METHODS.has(method) && text.length > 200 && !warnings.length) {
    return { tier: "high", avgOcrConfidence, reason: `clean ${method} extraction, ${text.length} chars, no warnings` };
  }

  if (RASTER_METHODS.has(method) && (avgOcrConfidence < 75 || text.length < 150 || warnings.length > 0)) {
    return { tier: "low", avgOcrConfidence, reason: `weak OCR (avg conf ${avgOcrConfidence}, ${text.length} chars, ${warnings.length} warnings)` };
  }

  return { tier: "medium", avgOcrConfidence, reason: `usable but unverified ${method || "unknown"} extraction` };
}

function averageOcrConfidence(layout) {
  const pages = Array.isArray(layout?.pages) ? layout.pages : [];
  const values = pages
    .flatMap((page) => page.blocks || [])
    .flatMap((block) => block.paragraphs || [])
    .flatMap((paragraph) => paragraph.lines || [])
    .map((line) => line.confidence)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!values.length) return 100; // no OCR confidence data means it wasn't OCR'd (e.g. native text) - treat as trustworthy
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

async function callOpenAI(pipeline, mode, source) {
  const quality = assessDocumentQuality(pipeline);
  // High-quality, deterministically-extracted documents don't need the expensive model to structure
  // already-correct text. Anything uncertain gets the strong model from the start.
  const primaryModel = quality.tier === "high" ? OPENAI_REPAIR_MODEL : OPENAI_MODEL;

  const systemPrompt = `You are an expert document intelligence engine specializing in zero-error structured extraction.

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
    {
      "category": "string",
      "items": [
        { "value": "string", "evidence": "string", "page": 1 }
      ]
    }
  ],
  "tables": [
    {
      "title": "string",
      "page": 1,
      "columns": ["string"],
      "rows": [["string"]],
      "evidence": "string"
    }
  ],
  "key_value_pairs": [
    {
      "label": "string",
      "value": "string",
      "evidence": "string",
      "page": 1
    }
  ]
}`;

  const userPayload = {
    file: {
      filename: pipeline.filename,
      mimeType: pipeline.mimeType,
      pages: pipeline.pages,
      extractionMethod: pipeline.extractionMethod,
      visualPages: Array.isArray(pipeline.visualPages)
        ? pipeline.visualPages.map((page) => ({ page: page.page, mimeType: page.mimeType }))
        : [],
      warnings: pipeline.warnings || []
    },
    document_text: pipeline.text,
    layout: compactLayout(pipeline.layout),
    mode
  };

  const userContent = [
    {
      type: "input_text",
      text: `Read the document intelligence payload and return the final structured JSON.\n\n${JSON.stringify(userPayload, null, 2)}`
    }
  ];

  // Native text extraction (docling/pdf-text) is already complete and far cheaper than vision tokens.
  // Only spend on page images when the file quality assessment says the text layer can't be trusted
  // alone - that's where the model genuinely needs to "see" the page to recover tables and fields.
  // The repair pass still has images available regardless, as a safety net for whichever path is used.
  const visualPages = Array.isArray(pipeline.visualPages) ? pipeline.visualPages : [];
  const shouldAttachImages = quality.tier !== "high" && visualPages.length;

  if (shouldAttachImages) {
    userContent.push({
      type: "input_text",
      text: "The following page images are rendered from the uploaded document. Use them to recover text, tables, totals, dates, and fields when OCR/layout text is incomplete."
    });
    for (const page of visualPages.slice(0, 2)) {
      if (!page.dataUrl) continue;
      userContent.push({
        type: "input_text",
        text: `Rendered page ${page.page || 1}`
      });
      userContent.push({
        type: "input_image",
        image_url: page.dataUrl
      });
    }
  }

  if (
    !shouldAttachImages &&
    !visualPages.length &&
    source?.sourceDataUrl &&
    source.sourceMimeType?.startsWith("image/")
  ) {
    userContent.push({
      type: "input_image",
      image_url: source.sourceDataUrl
    });
  }

  const parsed = await requestStructuredJson(systemPrompt, userContent, primaryModel);
  const modelsUsed = new Set([primaryModel]);

  let incompleteTables = findIncompleteTables(parsed.tables);
  if (incompleteTables.length && visualPages.length) {
    // Tier 1: try the cheap repair model first - most table misses are simple re-reads it handles fine.
    const repaired = await repairIncompleteTables(parsed, incompleteTables, visualPages, OPENAI_REPAIR_MODEL);
    if (repaired) parsed.tables = repaired;
    modelsUsed.add(OPENAI_REPAIR_MODEL);

    // Tier 2: escalate to the strong model, but only for rows the cheap pass still couldn't fix.
    // This is what keeps average cost low while still pushing toward near-complete accuracy on the
    // hard cases, instead of paying full-model price on every document up front.
    incompleteTables = findIncompleteTables(parsed.tables);
    if (incompleteTables.length && OPENAI_REPAIR_MODEL !== OPENAI_MODEL) {
      const escalated = await repairIncompleteTables(parsed, incompleteTables, visualPages, OPENAI_MODEL);
      if (escalated) parsed.tables = escalated;
      modelsUsed.add(OPENAI_MODEL);
    }
  }

  // Lower-confidence files (medium/low quality tier) are also the ones most likely to have dropped
  // or blank key-value pairs, so only run this extra check there - high-tier docs rarely need it and
  // skipping it keeps their cost low.
  if (quality.tier !== "high") {
    let incompletePairs = findIncompleteKeyValuePairs(parsed.key_value_pairs);
    if (incompletePairs.length && visualPages.length) {
      const repaired = await repairIncompleteKeyValuePairs(parsed, incompletePairs, visualPages, OPENAI_REPAIR_MODEL);
      if (repaired) parsed.key_value_pairs = repaired;
      modelsUsed.add(OPENAI_REPAIR_MODEL);

      incompletePairs = findIncompleteKeyValuePairs(parsed.key_value_pairs);
      if (incompletePairs.length && OPENAI_REPAIR_MODEL !== OPENAI_MODEL) {
        const escalated = await repairIncompleteKeyValuePairs(parsed, incompletePairs, visualPages, OPENAI_MODEL);
        if (escalated) parsed.key_value_pairs = escalated;
        modelsUsed.add(OPENAI_MODEL);
      }
    }
  }

  parsed.__quality = { tier: quality.tier, reason: quality.reason, modelsUsed: Array.from(modelsUsed) };
  return parsed;
}

async function requestStructuredJson(systemPrompt, userContent, model = OPENAI_MODEL) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: userContent
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || `OpenAI request failed with status ${response.status}`;
    throw new Error(message);
  }

  const parsed = safeParseJson(payload.output_text || extractOutputText(payload));
  if (!parsed) {
    throw new Error("OpenAI returned an unparseable response.");
  }

  return parsed;
}

function compactLayout(layout) {
  // Docling's doc_dict (used for PPTX/DOCX/docling-routed PDFs) carries full bbox/provenance trees
  // for every text run, table, and group - it can be the single largest part of the request for a
  // multi-slide deck. document_text already holds the same content as readable markdown, so the
  // structured layout adds no extraction value here and is dropped entirely rather than trimmed.
  const isDoclingShape =
    Array.isArray(layout?.texts) || Array.isArray(layout?.tables) || Array.isArray(layout?.key_value_items);
  if (isDoclingShape) {
    return { note: "Layout omitted - see document_text (markdown) for full content." };
  }

  // The model never asked for pixel coordinates or per-word OCR confidence - only the text matters
  // for extraction. Bounding boxes alone can be 70%+ of the layout JSON's token weight on dense pages.
  const pages = Array.isArray(layout?.pages) ? layout.pages : [];
  if (!pages.length) return layout || {};

  return {
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      lines: (page.blocks || [])
        .flatMap((block) => block.paragraphs || [])
        .flatMap((paragraph) => paragraph.lines || [])
        .map((line) => line.text)
        .filter(Boolean)
    }))
  };
}

function findIncompleteTables(tables) {
  if (!Array.isArray(tables)) return [];
  const indexes = [];
  tables.forEach((table, index) => {
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (!columns.length || !rows.length) return;
    const isIncomplete = rows.some((row) => {
      const cells = Array.isArray(row) ? row : [row];
      if (cells.length !== columns.length) return true;
      const blanks = cells.filter((cell) => String(cell ?? "").trim() === "").length;
      return blanks / cells.length > 0.3;
    });
    if (isIncomplete) indexes.push(index);
  });
  return indexes;
}

async function repairIncompleteTables(parsed, incompleteIndexes, visualPages, model) {
  const tablesToFix = incompleteIndexes.map((index) => ({ index, table: parsed.tables[index] }));

  const repairPrompt = `You are correcting incomplete tables extracted from a document.

You will be given the page images and a JSON list of tables that have missing or short rows.
Re-read every row directly from the image, cell by cell, including small print in rate/qty/tax/amount columns.
Return ONLY a JSON object: { "tables": [ { "index": 0, "columns": ["string"], "rows": [["string"]] } ] }
Every row array must have exactly the same length as "columns". Use "" only for cells that are genuinely blank in the source. Never shorten or omit a row.`;

  const repairContent = [
    {
      type: "input_text",
      text: `Tables that need correction:\n${JSON.stringify(tablesToFix, null, 2)}`
    }
  ];

  // Only send the specific pages the broken tables live on, not every rendered page - the repair
  // call is already a cost add-on, so keep its image payload as small as the fix requires.
  const neededPages = new Set(tablesToFix.map(({ table }) => table?.page).filter(Boolean));
  const pagesToSend = neededPages.size ? visualPages.filter((page) => neededPages.has(page.page)) : visualPages.slice(0, 2);

  for (const page of pagesToSend) {
    if (!page.dataUrl) continue;
    repairContent.push({ type: "input_text", text: `Rendered page ${page.page || 1}` });
    repairContent.push({ type: "input_image", image_url: page.dataUrl });
  }

  try {
    const result = await requestStructuredJson(repairPrompt, repairContent, model);
    const fixedTables = Array.isArray(result?.tables) ? result.tables : [];
    const updated = [...parsed.tables];
    for (const fixed of fixedTables) {
      const index = Number(fixed?.index);
      if (!Number.isInteger(index) || !updated[index]) continue;
      updated[index] = {
        ...updated[index],
        columns: Array.isArray(fixed.columns) ? fixed.columns : updated[index].columns,
        rows: Array.isArray(fixed.rows) ? fixed.rows : updated[index].rows
      };
    }
    return updated;
  } catch {
    return null;
  }
}

function findIncompleteKeyValuePairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  const indexes = [];
  pairs.forEach((pair, index) => {
    const value = String(pair?.value ?? "").trim();
    const label = String(pair?.label ?? "").trim();
    if (label && !value) indexes.push(index);
  });
  return indexes;
}

async function repairIncompleteKeyValuePairs(parsed, incompleteIndexes, visualPages, model) {
  const pairsToFix = incompleteIndexes.map((index) => ({ index, pair: parsed.key_value_pairs[index] }));

  const repairPrompt = `You are correcting incomplete key-value pairs extracted from a document.

You will be given the page images and a JSON list of labels whose values were missed.
Re-read the document image directly to find the value for each labeled field. If it genuinely does not appear anywhere in the document, leave it as "".
Return ONLY a JSON object: { "key_value_pairs": [ { "index": 0, "value": "string" } ] }`;

  const repairContent = [
    {
      type: "input_text",
      text: `Key-value pairs that need correction:\n${JSON.stringify(pairsToFix, null, 2)}`
    }
  ];

  const neededPages = new Set(pairsToFix.map(({ pair }) => pair?.page).filter(Boolean));
  const pagesToSend = neededPages.size ? visualPages.filter((page) => neededPages.has(page.page)) : visualPages.slice(0, 2);

  for (const page of pagesToSend) {
    if (!page.dataUrl) continue;
    repairContent.push({ type: "input_text", text: `Rendered page ${page.page || 1}` });
    repairContent.push({ type: "input_image", image_url: page.dataUrl });
  }

  try {
    const result = await requestStructuredJson(repairPrompt, repairContent, model);
    const fixedPairs = Array.isArray(result?.key_value_pairs) ? result.key_value_pairs : [];
    const updated = [...parsed.key_value_pairs];
    for (const fixed of fixedPairs) {
      const index = Number(fixed?.index);
      if (!Number.isInteger(index) || !updated[index]) continue;
      updated[index] = { ...updated[index], value: fixed.value ?? updated[index].value };
    }
    return updated;
  } catch {
    return null;
  }
}

function computeExtractionQuality(pipeline, modelResult) {
  const text = String(pipeline?.text || "").trim();
  const pages = Number(pipeline?.pages || 0);
  const entities = Array.isArray(modelResult?.entities) ? modelResult.entities : [];
  const keyValuePairs = Array.isArray(modelResult?.key_value_pairs) ? modelResult.key_value_pairs : [];
  const tables = Array.isArray(modelResult?.tables) ? modelResult.tables : [];
  const warnings = Array.isArray(pipeline?.warnings) ? pipeline.warnings : [];
  const visualPages = Array.isArray(pipeline?.visualPages) ? pipeline.visualPages : [];
  const confidence = normalizeFraction(modelResult?.confidence);

  const methodWeights = {
    docling: 0.28,
    "pdf-text": 0.24,
    "local-text": 0.23,
    "pdf-ocr": 0.18,
    "heic-ocr": 0.18,
    "image-ocr": 0.18,
    "binary-metadata": 0.05
  };

  const methodScore = methodWeights[pipeline?.extractionMethod] || 0.14;
  const textScore = clamp(text.length / 2600, 0, 1) * 0.24;
  const pageScore = clamp(pages / 8, 0, 1) * 0.1;
  const structureScore = clamp((entities.length + keyValuePairs.length + tables.length) / 12, 0, 1) * 0.2;
  const evidenceScore = clamp(scoreEvidenceCoverage(entities, keyValuePairs, tables), 0, 1) * 0.12;
  const visualScore = clamp(visualPages.length / 3, 0, 1) * 0.12;
  const confidenceScore = confidence * 0.18;
  const warningPenalty = clamp(warnings.length * 0.03, 0, 0.12);
  const emptyPenalty = text || visualPages.length ? 0 : 0.12;

  const score = methodScore + textScore + pageScore + structureScore + evidenceScore + visualScore + confidenceScore - warningPenalty - emptyPenalty;
  return Math.round(clamp(score, 0.04, 0.98) * 100) / 100;
}

function scoreEvidenceCoverage(entities, keyValuePairs, tables) {
  let total = 0;
  let filled = 0;

  for (const entry of entities) {
    const items = Array.isArray(entry?.items) ? entry.items : [];
    for (const item of items) {
      total += 1;
      if (String(item?.value || "").trim()) filled += 1;
      if (String(item?.evidence || "").trim()) filled += 0.25;
    }
  }

  for (const item of keyValuePairs) {
    total += 1;
    if (String(item?.value || "").trim()) filled += 1;
    if (String(item?.evidence || "").trim()) filled += 0.25;
  }

  for (const table of tables) {
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    total += 1;
    if (rows.length) filled += 1;
    if (Array.isArray(table?.columns) && table.columns.length) filled += 0.5;
  }

  if (!total) return 0;
  return filled / (total * 1.25);
}

function extractOutputText(payload) {
  const chunks = [];
  for (const item of payload.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeFraction(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1) return clamp(numeric / 100, 0, 1);
  return clamp(numeric, 0, 1);
}

function deriveReviewStatus(extractionQuality, confidence) {
  const quality = normalizeFraction(extractionQuality);
  const confidenceScore = normalizeFraction(confidence);
  const blended = quality * 0.65 + confidenceScore * 0.35;

  if (blended >= 0.8) return "Ready for review";
  if (blended >= 0.55) return "Review recommended";
  return "Needs human review";
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const safePath = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(__dirname, "public", safePath);

  if (!fullPath.startsWith(join(__dirname, "public"))) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": staticTypes[extname(fullPath)] || "application/octet-stream" });
    res.end(file);
  } catch {
    const index = await readFile(join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing multipart boundary.");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const fields = {};
  const files = {};
  let cursor = buffer.indexOf(boundary);

  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

    const headerEnd = buffer.indexOf("\r\n\r\n", cursor, "utf8");
    if (headerEnd === -1) break;

    const headerText = buffer.slice(cursor, headerEnd).toString("utf8");
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary === -1) break;

    let partData = buffer.slice(headerEnd + 4, nextBoundary);
    if (partData.at(-2) === 13 && partData.at(-1) === 10) partData = partData.slice(0, -2);

    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const partType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();

    if (name && filename !== undefined) {
      files[name] = { filename: filename || "upload.bin", contentType: partType, data: partData };
    } else if (name) {
      fields[name] = partData.toString("utf8");
    }

    cursor = nextBoundary;
  }

  return { fields, files };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Upload is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function loadEnv() {
  const path = join(__dirname, ".env");
  if (!existsSync(path)) return;

  const text = Buffer.from(readFileSyncSafe(path)).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function sanitizeFileName(name) {
  const base = basename(String(name || "upload"));
  return base.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function readFileSyncSafe(path) {
  return readFileSync(path);
}
