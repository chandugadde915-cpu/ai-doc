export function isUseful(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  return !/^(n\/?a|none|null|undefined|unknown|-|--)$/i.test(text)
}

export function normalizeValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function collectUsedValues(keyValuePairs, tables) {
  const used = new Set()
  for (const item of Array.isArray(keyValuePairs) ? keyValuePairs : []) {
    if (isUseful(item?.value)) used.add(normalizeValue(item.value))
  }
  for (const table of Array.isArray(tables) ? tables : []) {
    for (const row of Array.isArray(table?.rows) ? table.rows : []) {
      const cells = Array.isArray(row) ? row : [row]
      for (const cell of cells) {
        if (isUseful(cell)) used.add(normalizeValue(cell))
      }
    }
  }
  return used
}

export function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export function setByPath(obj, path, value) {
  const keys = path.split('.')
  let target = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = Array.isArray(target) ? Number(keys[i]) : keys[i]
    if (target[key] === undefined) return
    target = target[key]
  }
  const lastKey = Array.isArray(target) ? Number(keys[keys.length - 1]) : keys[keys.length - 1]
  target[lastKey] = value
}

export function formatConfidencePercent(confidence) {
  const numeric = Number(confidence)
  if (Number.isFinite(numeric)) return `${Math.round(numeric * 100)}%`
  return 'unknown'
}

export function toFraction(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return numeric > 1 ? Math.max(0, Math.min(1, numeric / 100)) : Math.max(0, Math.min(1, numeric))
}

export function reviewStatusFromScores(extractionQuality, confidence) {
  const q = toFraction(extractionQuality)
  const c = toFraction(confidence)
  const blended = q * 0.65 + c * 0.35
  if (blended >= 0.8) return 'Ready for review'
  if (blended >= 0.55) return 'Review recommended'
  return 'Needs human review'
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function getExtension(name) {
  const match = /\.[^.]+$/.exec(name || '')
  return match ? match[0].slice(1) : ''
}

export function normalizeTableRow(row, length) {
  const cells = Array.isArray(row) ? row.slice(0, length) : [row]
  while (cells.length < length) cells.push('')
  return cells
}

// Entities: filter out empty/placeholder values, drop values already shown as a key-value pair or
// table cell (avoid redundant repeats), dedupe identical values across categories. Optionally group
// by page for multi-page documents instead of tagging every line.
export function buildEntityGroups(entities, usedValues, isMultiPage) {
  const entries = Array.isArray(entities) ? entities : []
  const seenGlobally = new Set()
  const usableEntries = entries
    .map((entry, entryIndex) => {
      const values = Array.isArray(entry.items) ? entry.items : []
      const usableItems = values
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => isUseful(item?.value))
        .filter(({ item }) => {
          const key = normalizeValue(item.value)
          if (usedValues.has(key)) return false
          if (seenGlobally.has(key)) return false
          seenGlobally.add(key)
          return true
        })
      return { entry, entryIndex, usableItems }
    })
    .filter(({ usableItems }) => usableItems.length > 0)

  if (!isMultiPage) {
    return [{ page: null, cards: usableEntries }]
  }

  const byPage = new Map()
  for (const { entry, entryIndex, usableItems } of usableEntries) {
    const itemsByPage = new Map()
    for (const occurrence of usableItems) {
      const page = Number(occurrence.item?.page) || 1
      if (!itemsByPage.has(page)) itemsByPage.set(page, [])
      itemsByPage.get(page).push(occurrence)
    }
    for (const [page, items] of itemsByPage) {
      if (!byPage.has(page)) byPage.set(page, [])
      byPage.get(page).push({ entry, entryIndex, usableItems: items })
    }
  }

  return Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map((page) => ({ page, cards: byPage.get(page) }))
}

export function buildKeyValueGroups(keyValuePairs, isMultiPage) {
  const entries = Array.isArray(keyValuePairs) ? keyValuePairs : []
  const seen = new Set()
  const usableEntries = entries
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isUseful(item?.value))
    .filter(({ item }) => {
      const key = `${normalizeValue(item?.label)}::${normalizeValue(item?.value)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  if (!isMultiPage) {
    return [{ page: null, cards: usableEntries }]
  }

  const byPage = new Map()
  for (const occurrence of usableEntries) {
    const page = Number(occurrence.item?.page) || 1
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page).push(occurrence)
  }

  return Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map((page) => ({ page, cards: byPage.get(page) }))
}

export function buildTableGroups(tables, isMultiPage) {
  const usableTables = (Array.isArray(tables) ? tables : [])
    .map((table, tableIndex) => {
      const columns = Array.isArray(table.columns) ? table.columns : []
      const rows = Array.isArray(table.rows) ? table.rows : []
      const seenRows = new Set()
      const usableRows = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => {
          const cells = Array.isArray(row) ? row : [row]
          return cells.some((cell) => isUseful(cell))
        })
        .filter(({ row }) => {
          const cells = Array.isArray(row) ? row : [row]
          const key = cells.map(normalizeValue).join('||')
          if (seenRows.has(key)) return false
          seenRows.add(key)
          return true
        })
      return { table, tableIndex, columns, usableRows }
    })
    .filter(({ columns, usableRows }) => columns.length > 0 && usableRows.length > 0)

  if (!isMultiPage) {
    return [{ page: null, cards: usableTables }]
  }

  const byPage = new Map()
  for (const usableTable of usableTables) {
    const page = Number(usableTable.table?.page) || 1
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page).push(usableTable)
  }

  return Array.from(byPage.keys())
    .sort((a, b) => a - b)
    .map((page) => ({ page, cards: byPage.get(page) }))
}
