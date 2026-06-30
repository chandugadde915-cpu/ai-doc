import { readFileSync } from "node:fs";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCLING_SCRIPT = join(WORKSPACE_ROOT, "scripts", "docling_extract.py");
const DOCLING_DEPS = join(WORKSPACE_ROOT, ".docling-deps");
const MAX_VISUAL_PAGES = 3;

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".sql",
  ".yaml",
  ".yml",
  ".log"
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".heic"]);

export function runDocumentPipeline(sourcePath, meta) {
  const extension = extname(meta.filename || sourcePath).toLowerCase();
  const mimeType = meta.mimeType || "application/octet-stream";

  const docling = tryDoclingPipeline(
    sourcePath,
    mimeType,
    meta.filename || basename(sourcePath),
    extension
  );
  if (docling) {
    return docling;
  }

  if (TEXT_FILE_EXTENSIONS.has(extension) || mimeType.startsWith("text/")) {
    return buildTextPipeline(sourcePath, mimeType, meta.filename || basename(sourcePath));
  }

  if (extension === ".pdf" || mimeType === "application/pdf") {
    return buildPdfPipeline(sourcePath, mimeType, meta.filename || basename(sourcePath));
  }

  if (IMAGE_EXTENSIONS.has(extension) || mimeType.startsWith("image/")) {
    return buildImagePipeline(sourcePath, mimeType, meta.filename || basename(sourcePath));
  }

  return buildBinaryPipeline(sourcePath, mimeType, meta.filename || basename(sourcePath));
}

function tryDoclingPipeline(sourcePath, mimeType, filename, extension) {
  if (!existsSync(DOCLING_SCRIPT)) return null;

  const result = runCommand("python3", [DOCLING_SCRIPT, sourcePath], {
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${DOCLING_DEPS}:${process.env.PYTHONPATH}`
        : DOCLING_DEPS
    },
    maxBuffer: 80 * 1024 * 1024
  });

  if (result.code !== 0) {
    return null;
  }

  const parsed = safeJson(result.stdout);
  if (!parsed || !parsed.ok) {
    return null;
  }

  const text = String(parsed.text || "").trim();
  const layout = parsed.layout || {};
  const hasPages = Number(parsed.pages || 0) > 0;
  const hasContent = text.length > 0 || hasMeaningfulDoclingLayout(layout);

  if (!hasContent && (extension === ".pdf" || IMAGE_EXTENSIONS.has(extension) || mimeType.startsWith("image/"))) {
    return null;
  }

  return {
    extractionMethod: parsed.extractionMethod || "docling",
    mimeType,
    filename: parsed.filename || filename,
    pages: parsed.pages || 1,
    text,
    layout,
    visualPages: buildVisualPages(sourcePath, extension, mimeType),
    warnings: hasPages ? [] : ["Docling returned no page data."]
  };
}

function buildTextPipeline(sourcePath, mimeType, filename) {
  const text = readFileSync(sourcePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const layout = {
    pages: [
      {
        pageNumber: 1,
        blocks: [
          {
            blockNumber: 1,
            paragraphs: [
              {
                paragraphNumber: 1,
                bbox: null,
                lines: lines.map((line, index) => ({
                  lineNumber: index + 1,
                  text: line,
                  bbox: null,
                  confidence: 1
                }))
              }
            ]
          }
        ]
      }
    ]
  };

  return {
    extractionMethod: "local-text",
    mimeType,
    filename,
    pages: 1,
    text,
    layout
  };
}

function buildPdfPipeline(sourcePath, mimeType, filename) {
  const tempDir = mkdtempSync(join(tmpdir(), "doc-pdf-"));
  try {
    const tsvPath = join(tempDir, "document.tsv");
    const textPath = join(tempDir, "document.txt");
    const tsv = runCommand("pdftotext", ["-tsv", sourcePath, tsvPath]);
    const text = runCommand("pdftotext", ["-layout", "-nopgbrk", sourcePath, textPath]);
    if (tsv.code !== 0) {
      throw new Error(tsv.stderr || "Failed to extract PDF structure.");
    }

    const parsed = parseTsv(readSafeFile(tsvPath));
    const plainText = existsSync(textPath) ? readSafeFile(textPath) : text.stdout;

    const combinedText = (parsed.text || plainText || "").trim();

    if (parsed.pages.length && combinedText.length > 24) {
      return {
        extractionMethod: "pdf-text",
        mimeType,
        filename,
        pages: parsed.pages.length,
        text: combinedText,
        layout: parsed.layout,
        visualPages: buildVisualPages(sourcePath, ".pdf", mimeType)
      };
    }

    return buildRasterOcrPipeline(sourcePath, mimeType, filename, "pdf-ocr");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildImagePipeline(sourcePath, mimeType, filename) {
  if (extname(sourcePath).toLowerCase() === ".heic") {
    const converted = convertHeicToPng(sourcePath);
    try {
      return buildRasterOcrPipeline(converted.path, mimeType, filename, "heic-ocr");
    } finally {
      rmSync(converted.path, { force: true });
      rmSync(converted.tempDir, { recursive: true, force: true });
    }
  }

  return buildRasterOcrPipeline(sourcePath, mimeType, filename, "image-ocr");
}

function buildBinaryPipeline(sourcePath, mimeType, filename) {
  return {
    extractionMethod: "binary-metadata",
    mimeType,
    filename,
    pages: 1,
    text: "",
    layout: {
      pages: [
        {
          pageNumber: 1,
          blocks: [],
          warnings: ["No text or OCR extractor matched this file type."]
        }
      ]
    }
  };
}

function buildRasterOcrPipeline(sourcePath, mimeType, filename, extractionMethod) {
  const tempDir = mkdtempSync(join(tmpdir(), "doc-pages-"));
  try {
    const pageImages = rasterizePdfOrImage(sourcePath, tempDir);
    const pages = [];
    const textParts = [];
    const visualPages = buildVisualPagesFromImages(pageImages, tempDir);

    for (let index = 0; index < pageImages.length; index += 1) {
      const imagePath = pageImages[index];
      const tsv = runCommand("tesseract", [imagePath, "stdout", "tsv"]);
      const parsed = parseTsv(tsv.stdout);
      if (parsed.text.trim()) textParts.push(parsed.text.trim());
      if (parsed.layout.pages[0]) {
        pages.push(parsed.layout.pages[0]);
      }
    }

    const layout = { pages };

    return {
      extractionMethod,
      mimeType,
      filename,
      pages: pages.length || 1,
      text: textParts.join("\n\n").trim(),
      layout,
      visualPages,
      warnings: pages.length ? [] : ["OCR produced no recognized page content."]
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function hasMeaningfulDoclingLayout(layout) {
  if (!layout || typeof layout !== "object") return false;
  const texts = Array.isArray(layout.texts) ? layout.texts : [];
  const tables = Array.isArray(layout.tables) ? layout.tables : [];
  const keyValueItems = Array.isArray(layout.key_value_items) ? layout.key_value_items : [];
  const pages = layout.pages && typeof layout.pages === "object" ? Object.keys(layout.pages).length : 0;
  return texts.length > 0 || tables.length > 0 || keyValueItems.length > 0 || pages > 0;
}

function rasterizePdfOrImage(sourcePath, tempDir) {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".pdf") {
    const prefix = join(tempDir, "page");
    const pdf = runCommand("pdftoppm", ["-r", "300", "-png", sourcePath, prefix]);
    if (pdf.code !== 0) {
      throw new Error(pdf.stderr || "Failed to rasterize PDF.");
    }
    return listPageImages(tempDir);
  }

  if (extension === ".heic") {
    const pngPath = join(tempDir, `${basename(sourcePath, extension)}.png`);
    const converted = runCommand("sips", ["-s", "format", "png", sourcePath, "--out", pngPath]);
    if (converted.code !== 0) {
      throw new Error(converted.stderr || "Failed to convert HEIC image.");
    }
    return [pngPath];
  }

  return [sourcePath];
}

function buildVisualPages(sourcePath, extension, mimeType) {
  if (!(extension === ".pdf" || IMAGE_EXTENSIONS.has(extension) || mimeType.startsWith("image/"))) {
    return [];
  }

  const tempDir = mkdtempSync(join(tmpdir(), "doc-visual-"));
  try {
    const pageImages = rasterizePdfOrImage(sourcePath, tempDir);
    return buildVisualPagesFromImages(pageImages, tempDir);
  } catch {
    return [];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildVisualPagesFromImages(pageImages, tempDir) {
  return pageImages.slice(0, MAX_VISUAL_PAGES).map((imagePath, index) => {
    const image = imagePathToDataUrl(imagePath, tempDir);
    return {
      page: index + 1,
      mimeType: image.mimeType,
      dataUrl: image.dataUrl
    };
  }).filter((page) => page.dataUrl);
}

function imagePathToDataUrl(imagePath, tempDir) {
  const extension = extname(imagePath).toLowerCase();
  const supported = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };

  if (supported[extension]) {
    return {
      mimeType: supported[extension],
      dataUrl: `data:${supported[extension]};base64,${readFileSync(imagePath).toString("base64")}`
    };
  }

  const pngPath = join(tempDir, `${basename(imagePath, extension)}-visual.png`);
  const converted = runCommand("sips", ["-s", "format", "png", imagePath, "--out", pngPath]);
  if (converted.code !== 0 || !existsSync(pngPath)) {
    return { mimeType: "", dataUrl: "" };
  }

  return {
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${readFileSync(pngPath).toString("base64")}`
  };
}

function convertHeicToPng(sourcePath) {
  const tempDir = mkdtempSync(join(tmpdir(), "doc-heic-"));
  const pngPath = join(tempDir, `${basename(sourcePath, ".heic")}.png`);
  const converted = runCommand("sips", ["-s", "format", "png", sourcePath, "--out", pngPath]);
  if (converted.code !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(converted.stderr || "Failed to convert HEIC image.");
  }
  return { path: pngPath, tempDir };
}

function parseTsv(tsvText) {
  const lines = String(tsvText || "").trim().split(/\r?\n/);
  if (lines.length <= 1) {
    return { text: "", layout: { pages: [] }, pages: [] };
  }

  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return {
      level: Number(cells[0] || 0),
      page_num: Number(cells[1] || 0),
      block_num: Number(cells[2] || 0),
      par_num: Number(cells[3] || 0),
      line_num: Number(cells[4] || 0),
      word_num: Number(cells[5] || 0),
      left: Number(cells[6] || 0),
      top: Number(cells[7] || 0),
      width: Number(cells[8] || 0),
      height: Number(cells[9] || 0),
      conf: Number(cells[10] || 0),
      text: cells.slice(11).join("\t") || ""
    };
  });

  const pages = [];
  const pageMap = new Map();
  const textParts = [];

  for (const row of rows.filter((item) => item.level === 5 && item.text.trim())) {
    const page = ensurePage(pageMap, pages, row.page_num);
    const block = ensureBlock(page, row.block_num);
    const paragraph = ensureParagraph(block, row.par_num);
    const line = ensureLine(paragraph, row.line_num);
    line.words.push({
      text: row.text,
      bbox: toBBox(row),
      confidence: row.conf
    });
  }

  for (const page of pages) {
    for (const block of page.blocks) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          line.text = line.words.map((word) => word.text).join(" ").trim();
          line.bbox = mergeBoxes(line.words.map((word) => word.bbox));
          line.confidence = average(line.words.map((word) => word.confidence));
          if (line.text) textParts.push(line.text);
        }
      }
    }
  }

  return {
    text: textParts.join("\n"),
    layout: {
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        blocks: page.blocks.map((block) => ({
          blockNumber: block.blockNumber,
          bbox: block.bbox,
          paragraphs: block.paragraphs.map((paragraph) => ({
            paragraphNumber: paragraph.paragraphNumber,
            bbox: paragraph.bbox,
            lines: paragraph.lines.map((line) => ({
              lineNumber: line.lineNumber,
              text: line.text,
              bbox: line.bbox,
              confidence: line.confidence
            }))
          }))
        }))
      }))
    },
    pages
  };

  function ensurePage(pageMap, pages, pageNumber) {
    if (!pageMap.has(pageNumber)) {
      const page = { pageNumber, blocks: [] };
      pageMap.set(pageNumber, page);
      pages.push(page);
    }
    return pageMap.get(pageNumber);
  }

  function ensureBlock(page, blockNumber) {
    let block = page.blocks.find((item) => item.blockNumber === blockNumber);
    if (!block) {
      block = { blockNumber, paragraphs: [], bbox: null };
      page.blocks.push(block);
    }
    return block;
  }

  function ensureParagraph(block, paragraphNumber) {
    let paragraph = block.paragraphs.find((item) => item.paragraphNumber === paragraphNumber);
    if (!paragraph) {
      paragraph = { paragraphNumber, lines: [], bbox: null };
      block.paragraphs.push(paragraph);
    }
    return paragraph;
  }

  function ensureLine(paragraph, lineNumber) {
    let line = paragraph.lines.find((item) => item.lineNumber === lineNumber);
    if (!line) {
      line = { lineNumber, words: [], text: "", bbox: null, confidence: 0 };
      paragraph.lines.push(line);
    }
    return line;
  }
}

function readSafeFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function runCommand(command, args) {
  let options = { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 };
  if (arguments.length > 2 && typeof arguments[2] === "object") {
    options = { ...options, ...arguments[2] };
  }
  const result = spawnSync(command, args, options);
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function safeJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

function listPageImages(tempDir) {
  return readDirSorted(tempDir).filter((item) => /\.(png|jpg|jpeg)$/i.test(item)).map((item) => join(tempDir, item));
}

function readDirSorted(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function toBBox(row) {
  return {
    x: row.left,
    y: row.top,
    width: row.width,
    height: row.height
  };
}

function mergeBoxes(boxes) {
  const filtered = boxes.filter(Boolean);
  if (!filtered.length) return null;
  const x1 = Math.min(...filtered.map((box) => box.x));
  const y1 = Math.min(...filtered.map((box) => box.y));
  const x2 = Math.max(...filtered.map((box) => box.x + box.width));
  const y2 = Math.max(...filtered.map((box) => box.y + box.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return 0;
  return Math.round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length);
}
