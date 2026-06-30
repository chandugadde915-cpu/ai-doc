const CURRENCY_RE = /^[+-]?[$€£¥₹]\s?[\d,]+(\.\d{1,2})?$|^[\d,]+(\.\d{1,2})?\s?(usd|eur|gbp|inr|jpy)$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i

export function isCurrencyLike(value) {
  return CURRENCY_RE.test(String(value ?? '').trim())
}

export function isDateLike(value) {
  return DATE_RE.test(String(value ?? '').trim())
}

export function valueKind(value) {
  if (isCurrencyLike(value)) return 'currency'
  if (isDateLike(value)) return 'date'
  return 'text'
}

// Best-effort icon per entity category / field label. Categories come straight from the model
// (free text, not an enum), so this matches on keywords rather than exact values.
const ICON_RULES = [
  [/organi[sz]ation|company|vendor|merchant|business/i, '\u{1F3E2}'], // building
  [/person|name|customer|contact|signat/i, '\u{1F464}'], // person
  [/date|time|due/i, '\u{1F4C5}'], // calendar
  [/amount|currency|total|balance|price|cost|tax|fee|payment/i, '\u{1F4B0}'], // money bag
  [/address|location|city|country|zip|postal/i, '\u{1F4CD}'], // pin
  [/email/i, '\u{2709}\u{FE0F}'], // envelope
  [/phone|tel|mobile/i, '\u{1F4DE}'], // phone
  [/invoice|document|title|number|id\b|reference/i, '\u{1F4C4}'], // page
  [/percent|rate|qty|quantity/i, '\u{1F522}'], // numbers
]

export function iconForLabel(label) {
  const text = String(label ?? '')
  for (const [pattern, icon] of ICON_RULES) {
    if (pattern.test(text)) return icon
  }
  return '\u{1F50D}' // magnifier, generic fallback
}

// Pull a handful of the most business-relevant key-value pairs to the top as "highlights" -
// the fields someone scanning the document would look for first.
const HIGHLIGHT_PRIORITY = [
  /total|grand total|balance due|amount due/i,
  /invoice\s*#|invoice number|document number|reference/i,
  /due date/i,
  /date(?!\s*of\s*birth)/i,
  /vendor|merchant|company|organi[sz]ation|bill(ed)?\s*to|customer/i,
  /tax|gst|vat/i,
]

export function buildHighlights(keyValuePairs, maxItems = 4) {
  const entries = (Array.isArray(keyValuePairs) ? keyValuePairs : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => String(item?.value ?? '').trim())
  if (!entries.length) return []

  const scored = entries.map(({ item, index }) => {
    const label = String(item?.label ?? '')
    const priority = HIGHLIGHT_PRIORITY.findIndex((re) => re.test(label))
    return { item, index, score: priority === -1 ? HIGHLIGHT_PRIORITY.length : priority }
  })

  scored.sort((a, b) => a.score - b.score)

  const seen = new Set()
  const picked = []
  for (const { item, index, score } of scored) {
    if (score >= HIGHLIGHT_PRIORITY.length) continue
    const key = String(item.label ?? '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ item, index })
    if (picked.length >= maxItems) break
  }
  return picked
}
