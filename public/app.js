const form = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const filePreview = document.querySelector("#filePreview");
const submitButton = document.querySelector("#submitButton");
const emptyState = document.querySelector("#emptyState");
const loadingState = document.querySelector("#loadingState");
const errorState = document.querySelector("#errorState");
const resultCard = document.querySelector("#resultCard");
const apiStatus = document.querySelector("#apiStatus");
const apiStatusText = document.querySelector("#apiStatusText");
const sourceStatus = document.querySelector("#sourceStatus");
const sourcePreviewSurface = document.querySelector("#sourcePreviewSurface");
const sourceMetaGrid = document.querySelector("#sourceMetaGrid");
const sourceTabs = Array.from(document.querySelectorAll("[data-source-view]"));

const resultType = document.querySelector("#resultType");
const confidenceBadge = document.querySelector("#confidenceBadge");
const qualityBadge = document.querySelector("#qualityBadge");
const reviewBadge = document.querySelector("#reviewBadge");
const entitiesGrid = document.querySelector("#entitiesGrid");
const keyValueGrid = document.querySelector("#keyValueGrid");
const tablesList = document.querySelector("#tablesList");
const zoomToolbar = document.querySelector("#zoomToolbar");
const zoomInBtn = document.querySelector("#zoomInBtn");
const zoomOutBtn = document.querySelector("#zoomOutBtn");
const zoomResetBtn = document.querySelector("#zoomResetBtn");
const zoomFitBtn = document.querySelector("#zoomFitBtn");
const zoomLevel = document.querySelector("#zoomLevel");
const expandPreviewBtn = document.querySelector("#expandPreviewBtn");
const previewLightbox = document.querySelector("#previewLightbox");
const lightboxViewport = document.querySelector("#lightboxViewport");
const lightboxFilename = document.querySelector("#lightboxFilename");
const closeLightboxBtn = document.querySelector("#closeLightboxBtn");
const lbZoomInBtn = document.querySelector("#lbZoomInBtn");
const lbZoomOutBtn = document.querySelector("#lbZoomOutBtn");
const lbZoomFitBtn = document.querySelector("#lbZoomFitBtn");
const lbZoomLevel = document.querySelector("#lbZoomLevel");
const editStatus = document.querySelector("#editStatus");
const resetEditsBtn = document.querySelector("#resetEditsBtn");
const copyJsonBtn = document.querySelector("#copyJsonBtn");
const downloadJsonBtn = document.querySelector("#downloadJsonBtn");
let activeObjectUrl = "";
let activeSource = null;
let activeFile = null;
let activeFileText = "";
let sourceViewMode = "preview";
let originalPayload = null;
let editedPayload = null;
let isDirty = false;

const zoomState = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
const lbZoomState = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

zoomInBtn.addEventListener("click", () => setZoom(zoomState.scale + 0.25));
zoomOutBtn.addEventListener("click", () => setZoom(zoomState.scale - 0.25));
zoomResetBtn.addEventListener("click", () => {
  zoomState.x = 0;
  zoomState.y = 0;
  setZoom(1);
});
zoomFitBtn.addEventListener("click", () => fitZoom(zoomState, sourcePreviewSurface, zoomLevel, applyZoomTransform));

expandPreviewBtn.addEventListener("click", openLightbox);
closeLightboxBtn.addEventListener("click", closeLightbox);
previewLightbox.addEventListener("click", (event) => {
  if (event.target === previewLightbox) closeLightbox();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !previewLightbox.classList.contains("hidden")) closeLightbox();
});

lbZoomInBtn.addEventListener("click", () => setLbZoom(lbZoomState.scale + 0.25));
lbZoomOutBtn.addEventListener("click", () => setLbZoom(lbZoomState.scale - 0.25));
lbZoomFitBtn.addEventListener("click", () => fitZoom(lbZoomState, lightboxViewport, lbZoomLevel, applyLbZoomTransform));

function openLightbox() {
  const sourceImg = sourcePreviewSurface.querySelector(".zoom-target");
  if (!sourceImg) return;
  lightboxFilename.textContent = activeFile?.name || activeSource?.filename || "Document preview";
  lightboxViewport.innerHTML = `<img class="zoom-target" src="${sourceImg.src}" alt="Document preview, expanded" />`;
  previewLightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  lbZoomState.scale = 1;
  lbZoomState.x = 0;
  lbZoomState.y = 0;
  attachZoomDrag(lightboxViewport, lbZoomState, applyLbZoomTransform, setLbZoom);
  requestAnimationFrame(() => fitZoom(lbZoomState, lightboxViewport, lbZoomLevel, applyLbZoomTransform));
}

function closeLightbox() {
  previewLightbox.classList.add("hidden");
  document.body.style.overflow = "";
  lightboxViewport.innerHTML = "";
}

function setLbZoom(scale) {
  lbZoomState.scale = Math.min(6, Math.max(0.2, scale));
  lbZoomLevel.textContent = `${Math.round(lbZoomState.scale * 100)}%`;
  applyLbZoomTransform();
}

function applyLbZoomTransform() {
  const img = lightboxViewport.querySelector(".zoom-target");
  if (!img) return;
  img.style.transform = `translate(${lbZoomState.x}px, ${lbZoomState.y}px) scale(${lbZoomState.scale})`;
}

function fitZoom(state, viewportEl, levelLabelEl, applyFn) {
  const img = viewportEl.querySelector(".zoom-target");
  if (!img || !img.naturalWidth) return;
  const rect = viewportEl.getBoundingClientRect();
  const scale = Math.min((rect.width - 32) / img.naturalWidth, (rect.height - 32) / img.naturalHeight, 1);
  state.scale = Math.max(0.1, scale);
  state.x = (rect.width - img.naturalWidth * state.scale) / 2;
  state.y = (rect.height - img.naturalHeight * state.scale) / 2;
  levelLabelEl.textContent = `${Math.round(state.scale * 100)}%`;
  applyFn();
}

resetEditsBtn.addEventListener("click", () => {
  if (!originalPayload) return;
  editedPayload = deepClone(originalPayload);
  isDirty = false;
  renderResult(originalPayload, { keepSource: true });
  updateEditStatus();
});

copyJsonBtn.addEventListener("click", async () => {
  if (!editedPayload) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(editedPayload, null, 2));
    editStatus.textContent = "Copied JSON to clipboard";
    setTimeout(updateEditStatus, 1800);
  } catch {
    editStatus.textContent = "Copy failed - select and copy manually";
  }
});

downloadJsonBtn.addEventListener("click", () => {
  if (!editedPayload) return;
  const blob = new Blob([JSON.stringify(editedPayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(editedPayload.document_type || "document").toLowerCase().replace(/\s+/g, "-")}-corrected.json`;
  link.click();
  URL.revokeObjectURL(url);
});

checkHealth();

sourceTabs.forEach((button) => {
  button.addEventListener("click", () => {
    sourceViewMode = button.dataset.sourceView || "preview";
    syncSourceTabs();
    renderSourceSurface();
  });
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  activeFile = file || null;
  activeSource = null;
  activeFileText = "";
  sourceViewMode = "preview";
  syncSourceTabs();
  renderFilePreview(file);
  renderSelectedSourcePreview(file);
  if (!file) {
    renderEmptySourcePreview();
  }
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  if (!event.dataTransfer.files.length) return;
  fileInput.files = event.dataTransfer.files;
  activeFile = fileInput.files[0] || null;
  activeSource = null;
  activeFileText = "";
  sourceViewMode = "preview";
  syncSourceTabs();
  renderFilePreview(fileInput.files[0]);
  renderSelectedSourcePreview(fileInput.files[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    showError("Please choose a file first.");
    return;
  }

  setLoading(true);

  try {
    const formData = new FormData(form);
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: formData
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "The analysis request failed.");
    }

    renderResult(payload);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    apiStatus.className = `status-dot ${data.hasApiKey ? "ok" : "bad"}`;
    apiStatusText.textContent = data.hasApiKey ? `Backend ready using ${data.model}` : "Backend ready, API key missing";
  } catch {
    apiStatus.className = "status-dot bad";
    apiStatusText.textContent = "Backend unavailable";
  }
}

function renderFilePreview(file) {
  if (!file) {
    filePreview.classList.add("hidden");
    filePreview.textContent = "";
    return;
  }

  filePreview.classList.remove("hidden");
  filePreview.innerHTML = `
    <strong>${escapeHtml(file.name)}</strong>
    <span>${escapeHtml(file.type || "Unknown type")} · ${formatBytes(file.size)}</span>
  `;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.innerHTML = isLoading
    ? '<span class="button-icon" aria-hidden="true">...</span>Analyzing'
    : '<span class="button-icon" aria-hidden="true">-&gt;</span>Analyze document';

  if (isLoading) {
    emptyState.classList.add("hidden");
    errorState.classList.add("hidden");
    resultCard.classList.add("hidden");
    loadingState.classList.remove("hidden");
  } else {
    loadingState.classList.add("hidden");
  }
}

function showError(message) {
  emptyState.classList.add("hidden");
  loadingState.classList.add("hidden");
  resultCard.classList.add("hidden");
  errorState.classList.remove("hidden");
  errorState.textContent = message;
}

function renderResult(payload, options = {}) {
  errorState.classList.add("hidden");
  emptyState.classList.add("hidden");
  resultCard.classList.remove("hidden");

  if (!options.keepSource) {
    originalPayload = deepClone(payload);
    editedPayload = deepClone(payload);
    isDirty = false;
  }

  resultType.textContent = payload.document_type || "Document";
  confidenceBadge.textContent = `Accuracy ${formatConfidencePercent(payload.confidence)}`;
  qualityBadge.textContent = `Extraction quality ${formatConfidencePercent(payload.extraction_quality)}`;
  reviewBadge.textContent = payload.review_status || reviewStatusFromScores(payload.extraction_quality, payload.confidence);

  if (!options.keepSource) {
    renderSourcePanel(payload.source || {});
  }
  const usedValues = collectUsedValues(payload.key_value_pairs, payload.tables);
  const isMultiPage = Number(payload.source?.pages || payload.pages || 1) > 1;
  renderEntityGrid(payload.entities || {}, usedValues, isMultiPage);
  renderKeyValueGrid(payload.key_value_pairs || {}, isMultiPage);
  renderTables(payload.tables || [], isMultiPage);
  updateEditStatus();

  if (!options.keepSource) {
    resultCard.closest(".result-panel")?.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function updateEditStatus() {
  editStatus.classList.toggle("is-dirty", isDirty);
  editStatus.textContent = isDirty ? "Edited - not yet exported" : "Click any value to edit it";
}

function markDirty() {
  isDirty = true;
  updateEditStatus();
}

function setZoom(scale) {
  zoomState.scale = Math.min(4, Math.max(0.2, scale));
  zoomLevel.textContent = `${Math.round(zoomState.scale * 100)}%`;
  applyZoomTransform();
}

function applyZoomTransform() {
  const img = sourcePreviewSurface.querySelector(".zoom-target");
  if (!img) return;
  img.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
}

function attachZoomDrag(viewportEl, state, applyFn, setZoomFn) {
  viewportEl.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.15 : 0.15;
    setZoomFn(state.scale + delta);
  });

  viewportEl.addEventListener("mousedown", (event) => {
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    viewportEl.classList.add("is-dragging");
  });

  window.addEventListener("mousemove", (event) => {
    if (!state.dragging) return;
    state.x += event.clientX - state.lastX;
    state.y += event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    applyFn();
  });

  window.addEventListener("mouseup", () => {
    state.dragging = false;
    viewportEl.classList.remove("is-dragging");
  });
}

function attachZoomHandlers() {
  const viewport = sourcePreviewSurface.querySelector(".zoom-viewport");
  if (!viewport) {
    zoomToolbar.classList.add("hidden");
    return;
  }

  zoomToolbar.classList.remove("hidden");
  zoomState.scale = 1;
  zoomState.x = 0;
  zoomState.y = 0;
  zoomLevel.textContent = "100%";
  attachZoomDrag(viewport, zoomState, applyZoomTransform, setZoom);

  const img = viewport.querySelector(".zoom-target");
  if (img) {
    const startFit = () => fitZoom(zoomState, sourcePreviewSurface, zoomLevel, applyZoomTransform);
    if (img.complete && img.naturalWidth) {
      requestAnimationFrame(startFit);
    } else {
      img.addEventListener("load", startFit, { once: true });
    }
  }
}

function renderSourcePanel(source) {
  activeSource = source || null;
  sourceStatus.textContent = source?.extractionMethod || "Unknown method";

  const meta = [
    ["Filename", source?.filename || "Unknown"],
    ["MIME", source?.mimeType || "Unknown"],
    ["Pages", String(source?.pages ?? 0)],
    ["Method", source?.extractionMethod || "Unknown"]
  ];

  sourceMetaGrid.classList.remove("hidden");
  sourceMetaGrid.innerHTML = meta
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join("");

  renderSourceSurface();
}

function renderSelectedSourcePreview(file) {
  if (!file) {
    renderEmptySourcePreview();
    return;
  }

  sourceStatus.textContent = "Selected file";
  sourceMetaGrid.classList.remove("hidden");
  sourceMetaGrid.innerHTML = [
    ["Filename", file.name || "Unknown"],
    ["Type", file.type || "Unknown"],
    ["Size", formatBytes(file.size)],
    ["Status", "Ready to analyze"]
  ]
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join("");

  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = "";
  }

  if (file.type && file.type.startsWith("image/")) {
    activeObjectUrl = URL.createObjectURL(file);
    renderSourceSurface();
    return;
  }

  if (isTextLike(file)) {
    const reader = new FileReader();
    reader.onload = () => {
      activeFileText = String(reader.result || "");
      renderSourceSurface();
    };
    reader.onerror = () => {
      activeFileText = "";
      renderSourceSurface();
    };
    reader.readAsText(file);
    return;
  }

  activeFileText = "";
  renderSourceSurface();
}

function renderEmptySourcePreview() {
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = "";
  }

  activeSource = null;
  activeFile = null;
  activeFileText = "";
  sourceViewMode = "preview";
  syncSourceTabs();
  sourceStatus.textContent = "Waiting for upload";
  sourceMetaGrid.classList.add("hidden");
  sourceMetaGrid.innerHTML = "";
  renderSourceSurface();
}

function isUseful(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return !/^(n\/?a|none|null|undefined|unknown|-|--)$/i.test(text);
}

function normalizeValue(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function collectUsedValues(keyValuePairs, tables) {
  const used = new Set();
  for (const item of Array.isArray(keyValuePairs) ? keyValuePairs : []) {
    if (isUseful(item?.value)) used.add(normalizeValue(item.value));
  }
  for (const table of Array.isArray(tables) ? tables : []) {
    for (const row of Array.isArray(table?.rows) ? table.rows : []) {
      const cells = Array.isArray(row) ? row : [row];
      for (const cell of cells) {
        if (isUseful(cell)) used.add(normalizeValue(cell));
      }
    }
  }
  return used;
}

function renderEntityGrid(entities, usedValues = new Set(), isMultiPage = false) {
  const entries = Array.isArray(entities) ? entities : [];
  const seenGlobally = new Set();
  const usableEntries = entries
    .map((entry, entryIndex) => {
      const values = Array.isArray(entry.items) ? entry.items : [];
      const usableItems = values
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => isUseful(item?.value))
        .filter(({ item }) => {
          const key = normalizeValue(item.value);
          // Skip values already shown as a key-value pair or table cell - they're already "used" with context there.
          if (usedValues.has(key)) return false;
          // Skip exact duplicates repeated across entity categories.
          if (seenGlobally.has(key)) return false;
          seenGlobally.add(key);
          return true;
        });
      return { entry, entryIndex, usableItems };
    })
    .filter(({ usableItems }) => usableItems.length > 0);

  if (!usableEntries.length) {
    entitiesGrid.innerHTML = `<div class="data-card"><strong>None</strong><span>No usable entities were found.</span></div>`;
    return;
  }

  const renderEntityCards = (groups) =>
    groups
      .map(({ entry, entryIndex, usableItems }) => {
        const rows = usableItems
          .slice(0, 8)
          .map(
            ({ item, itemIndex }) => `
              <div class="editable-line">
                <span contenteditable="true" data-edit-path="entities.${entryIndex}.items.${itemIndex}.value">${escapeHtml(
                  item.value ?? ""
                )}</span>
              </div>
            `
          )
          .join("");
        return `
          <div class="data-card">
            <strong>${escapeHtml(entry.category || "Entity")}</strong>
            <div class="editable-list">${rows}</div>
          </div>
        `;
      })
      .join("");

  if (!isMultiPage) {
    entitiesGrid.innerHTML = renderEntityCards(usableEntries);
    bindEditableHandlers(entitiesGrid);
    return;
  }

  // Multi-page: split each category's items by the page they were found on, so the output reads
  // as "what's on page 1" / "what's on page 2" instead of a per-line page tag on every value.
  const byPage = new Map();
  for (const { entry, entryIndex, usableItems } of usableEntries) {
    const itemsByPage = new Map();
    for (const occurrence of usableItems) {
      const page = Number(occurrence.item?.page) || 1;
      if (!itemsByPage.has(page)) itemsByPage.set(page, []);
      itemsByPage.get(page).push(occurrence);
    }
    for (const [page, usableItemsOnPage] of itemsByPage) {
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push({ entry, entryIndex, usableItems: usableItemsOnPage });
    }
  }

  entitiesGrid.innerHTML = Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map(
      (page) => `
        <div class="page-group">
          <h4 class="page-group-heading">Page ${page}</h4>
          <div class="data-grid">${renderEntityCards(byPage.get(page))}</div>
        </div>
      `
    )
    .join("");

  bindEditableHandlers(entitiesGrid);
}

function renderKeyValueGrid(keyValuePairs, isMultiPage = false) {
  const entries = Array.isArray(keyValuePairs) ? keyValuePairs : [];
  const seen = new Set();
  const usableEntries = entries
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isUseful(item?.value))
    .filter(({ item }) => {
      // Skip an exact repeat of the same label+value pair.
      const key = `${normalizeValue(item?.label)}::${normalizeValue(item?.value)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (!usableEntries.length) {
    keyValueGrid.innerHTML = `<div class="data-card"><strong>None</strong><span>No usable key-value pairs were found.</span></div>`;
    return;
  }

  const renderKvCards = (group) =>
    group
      .map(({ item, index }) => {
        const value = item?.value || "";
        return `
          <div class="data-card">
            <strong>${escapeHtml(item?.label || "Field")}</strong>
            <span contenteditable="true" data-edit-path="key_value_pairs.${index}.value">${escapeHtml(value)}</span>
          </div>
        `;
      })
      .join("");

  if (!isMultiPage) {
    keyValueGrid.innerHTML = renderKvCards(usableEntries);
    bindEditableHandlers(keyValueGrid);
    return;
  }

  const byPage = new Map();
  for (const occurrence of usableEntries) {
    const page = Number(occurrence.item?.page) || 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(occurrence);
  }

  keyValueGrid.innerHTML = Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map(
      (page) => `
        <div class="page-group">
          <h4 class="page-group-heading">Page ${page}</h4>
          <div class="data-grid">${renderKvCards(byPage.get(page))}</div>
        </div>
      `
    )
    .join("");

  bindEditableHandlers(keyValueGrid);
}

function renderTables(tables, isMultiPage = false) {
  const usableTables = (Array.isArray(tables) ? tables : [])
    .map((table, tableIndex) => {
      const columns = Array.isArray(table.columns) ? table.columns : [];
      const rows = Array.isArray(table.rows) ? table.rows : [];
      const seenRows = new Set();
      const usableRows = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => {
          const cells = Array.isArray(row) ? row : [row];
          return cells.some((cell) => isUseful(cell));
        })
        .filter(({ row }) => {
          // Skip an exact duplicate row (same values in the same order).
          const cells = Array.isArray(row) ? row : [row];
          const key = cells.map(normalizeValue).join("||");
          if (seenRows.has(key)) return false;
          seenRows.add(key);
          return true;
        });
      return { table, tableIndex, columns, usableRows };
    })
    .filter(({ columns, usableRows }) => columns.length > 0 && usableRows.length > 0);

  if (!usableTables.length) {
    tablesList.innerHTML = `<div class="table-card"><strong>No tables detected</strong><span>The model did not identify any usable tables in this document.</span></div>`;
    return;
  }

  const renderTableCard = ({ table, tableIndex, columns, usableRows }) => {
    const tableHead = columns.length
      ? `<div class="table-head">${columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}</div>`
      : "";
    const tableRows = usableRows
      .map(({ row, rowIndex }) => {
        const cells = columns.length ? normalizeTableRow(row, columns.length) : Array.isArray(row) ? row : [row];
        return `<div class="table-row">${cells
          .map(
            (cell, cellIndex) =>
              `<span contenteditable="true" data-edit-path="tables.${tableIndex}.rows.${rowIndex}.${cellIndex}">${escapeHtml(
                String(cell ?? "")
              )}</span>`
          )
          .join("")}</div>`;
      })
      .join("");

    return `
      <div class="table-card">
        <header>
          <strong>${escapeHtml(table.title || `Table ${tableIndex + 1}`)}</strong>
          ${isMultiPage ? "" : `<span>Page ${table.page || 1}</span>`}
        </header>
        ${tableHead}
        <div class="table-grid">
          ${tableRows || `<div class="table-row"><span>No rows available</span></div>`}
        </div>
      </div>
    `;
  };

  if (!isMultiPage) {
    tablesList.innerHTML = usableTables.map(renderTableCard).join("");
    bindEditableHandlers(tablesList);
    return;
  }

  const byPage = new Map();
  for (const usableTable of usableTables) {
    const page = Number(usableTable.table?.page) || 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(usableTable);
  }

  tablesList.innerHTML = Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map(
      (page) => `
        <div class="page-group">
          <h4 class="page-group-heading">Page ${page}</h4>
          <div class="tables-list">${byPage.get(page).map(renderTableCard).join("")}</div>
        </div>
      `
    )
    .join("");

  bindEditableHandlers(tablesList);
}

function bindEditableHandlers(container) {
  container.querySelectorAll("[contenteditable='true']").forEach((el) => {
    el.addEventListener("blur", () => {
      const path = el.dataset.editPath;
      if (!path || !editedPayload) return;
      setByPath(editedPayload, path, el.textContent.trim());
      el.classList.add("is-edited");
      markDirty();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        el.blur();
      }
    });
  });
}

function setByPath(obj, path, value) {
  const keys = path.split(".");
  let target = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = Array.isArray(target) ? Number(keys[i]) : keys[i];
    if (target[key] === undefined) return;
    target = target[key];
  }
  const lastKey = Array.isArray(target) ? Number(keys[keys.length - 1]) : keys[keys.length - 1];
  target[lastKey] = value;
}

function normalizeTableRow(row, length) {
  const cells = Array.isArray(row) ? row.slice(0, length) : [row];
  while (cells.length < length) {
    cells.push("");
  }
  return cells;
}

function renderSourceSurface() {
  syncSourceTabs();
  zoomToolbar.classList.add("hidden");
  const source = activeSource || {};
  const file = activeFile;
  const mode = sourceViewMode;

  if (mode === "layout") {
    const layout = source.layout || null;
    sourcePreviewSurface.innerHTML = layout
      ? `<pre class="source-json-preview">${escapeHtml(JSON.stringify(layout, null, 2).slice(0, 12000))}</pre>`
      : `<div class="input-placeholder"><span class="input-placeholder-icon" aria-hidden="true">LAY</span><strong>No layout yet</strong><span>Layout JSON appears after analysis.</span></div>`;
    return;
  }

  if (mode === "text") {
    const text = String(source.text || activeFileText || "").trim();
    sourcePreviewSurface.innerHTML = text
      ? `<pre class="source-text-preview">${escapeHtml(text.slice(0, 12000))}</pre>`
      : `<div class="input-placeholder"><span class="input-placeholder-icon" aria-hidden="true">TXT</span><strong>No transcript yet</strong><span>OCR or text extraction will appear here after analysis.</span></div>`;
    return;
  }

  if (source.mimeType && source.mimeType.startsWith("image/") && activeObjectUrl) {
    sourcePreviewSurface.innerHTML = `<div class="zoom-viewport"><img class="zoom-target" src="${activeObjectUrl}" alt="Selected document preview" /></div>`;
    attachZoomHandlers();
    return;
  }

  if (typeof source.text === "string" && source.text.trim()) {
    sourcePreviewSurface.innerHTML = `<pre class="source-text-preview">${escapeHtml(source.text.slice(0, 12000))}</pre>`;
    return;
  }

  if (activeFile && activeFile.type && activeFile.type.startsWith("image/") && activeObjectUrl) {
    sourcePreviewSurface.innerHTML = `<div class="zoom-viewport"><img class="zoom-target" src="${activeObjectUrl}" alt="Selected document preview" /></div>`;
    attachZoomHandlers();
    return;
  }

  if (activeFileText) {
    sourcePreviewSurface.innerHTML = `<pre class="source-text-preview">${escapeHtml(activeFileText.slice(0, 12000))}</pre>`;
    return;
  }

  if (activeFile) {
    const extension = getExtension(activeFile.name) || "file";
    sourcePreviewSurface.innerHTML = `
      <div class="source-file-preview">
        <span class="source-file-badge">${escapeHtml(extension.slice(0, 6))}</span>
        <strong>${escapeHtml(activeFile.name)}</strong>
        <span>${escapeHtml(activeFile.type || "This file type does not have a browser preview.")}</span>
      </div>
    `;
    return;
  }

  sourcePreviewSurface.innerHTML = `
    <div class="input-placeholder">
      <span class="input-placeholder-icon" aria-hidden="true">SRC</span>
      <strong>No document selected</strong>
      <span>The document preview, OCR transcript, and layout JSON appear here.</span>
    </div>
  `;
}

function syncSourceTabs() {
  sourceTabs.forEach((button) => {
    const isActive = button.dataset.sourceView === sourceViewMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function formatConfidencePercent(confidence) {
  if (typeof confidence === "number") {
    const value = Math.round(confidence * 100);
    return `${value}%`;
  }
  const numeric = Number(confidence);
  if (Number.isFinite(numeric)) {
    return `${Math.round(numeric * 100)}%`;
  }
  return "unknown";
}

function reviewStatusFromScores(extractionQuality, confidence) {
  const q = toFraction(extractionQuality);
  const c = toFraction(confidence);
  const blended = q * 0.65 + c * 0.35;
  if (blended >= 0.8) return "Ready for review";
  if (blended >= 0.55) return "Review recommended";
  return "Needs human review";
}

function toFraction(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1 ? Math.max(0, Math.min(1, numeric / 100)) : Math.max(0, Math.min(1, numeric));
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}
