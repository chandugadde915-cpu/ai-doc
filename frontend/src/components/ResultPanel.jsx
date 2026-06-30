import { motion } from 'framer-motion'
import { useState } from 'react'
import EditableSpan from './EditableSpan'
import FieldValue from './FieldValue'
import {
  buildEntityGroups,
  buildKeyValueGroups,
  buildTableGroups,
  collectUsedValues,
  formatConfidencePercent,
  normalizeTableRow,
  reviewStatusFromScores,
} from '../lib/dataUtils'
import { buildHighlights, iconForLabel } from '../lib/displayUtils'

const cardVariants = {
  hidden: { opacity: 0, y: 10 },
  show: (i) => ({ opacity: 1, y: 0, transition: { delay: Math.min(i * 0.035, 0.4), duration: 0.28, ease: 'easeOut' } }),
}

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}

export default function ResultPanel({ payload, isDirty, editedPaths, onEdit, onReset, onCopy, onDownload }) {
  const [density, setDensity] = useState('cards')
  const [verifiedPaths, setVerifiedPaths] = useState(new Set())

  const toggleVerified = (path) => {
    setVerifiedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const isMultiPage = Number(payload.source?.pages || payload.pages || 1) > 1
  const usedValues = collectUsedValues(payload.key_value_pairs, payload.tables)
  const entityGroups = buildEntityGroups(payload.entities, usedValues, isMultiPage)
  const kvGroups = buildKeyValueGroups(payload.key_value_pairs, isMultiPage)
  const tableGroups = buildTableGroups(payload.tables, isMultiPage)
  const highlights = buildHighlights(payload.key_value_pairs)

  const hasAnyEntities = entityGroups.some((g) => g.cards.length)
  const hasAnyKv = kvGroups.some((g) => g.cards.length)
  const hasAnyTables = tableGroups.some((g) => g.cards.length)

  return (
    <motion.article
      className="result-card"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: 'easeOut' }}
    >
      <header className="result-header">
        <div>
          <p className="eyebrow">Extracted data</p>
          <motion.h2 initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }}>
            {payload.document_type || 'Document'}
          </motion.h2>
        </div>
        <div className="result-badges">
          <Badge className="confidence-badge accuracy-badge" delay={0.05} title={buildModelTooltip(payload.processing)}>
            Accuracy {formatConfidencePercent(payload.confidence)}
          </Badge>
          <Badge className="confidence-badge quality-badge" delay={0.1}>
            Extraction quality {formatConfidencePercent(payload.extraction_quality)}
          </Badge>
          <Badge className="confidence-badge review-badge" delay={0.15}>
            {payload.review_status || reviewStatusFromScores(payload.extraction_quality, payload.confidence)}
          </Badge>
        </div>
      </header>

      {highlights.length > 0 && (
        <motion.div
          className="highlights-row"
          variants={containerVariants}
          initial="hidden"
          animate="show"
        >
          {highlights.map(({ item, index }, i) => {
            const path = `key_value_pairs.${index}.value`
            return (
              <motion.div className="highlight-card" key={path} variants={cardVariants} custom={i}>
                <span className="highlight-icon" aria-hidden="true">
                  {iconForLabel(item?.label)}
                </span>
                <div className="highlight-body">
                  <span className="highlight-label">{item?.label || 'Field'}</span>
                  <FieldValue
                    value={item?.value || ''}
                    edited={editedPaths.has(path)}
                    verified={verifiedPaths.has(path)}
                    onCommit={(value) => onEdit(path, value)}
                    onToggleVerify={() => toggleVerified(path)}
                  />
                </div>
              </motion.div>
            )
          })}
        </motion.div>
      )}

      <div className="edit-toolbar">
        <span className={`edit-status ${isDirty ? 'is-dirty' : ''}`}>
          {isDirty ? 'Edited - not yet exported' : 'Click any value to edit it'}
        </span>
        <div className="edit-actions">
          <div className="density-toggle" role="group" aria-label="Layout density">
            <button
              type="button"
              className={density === 'cards' ? 'is-active' : ''}
              onClick={() => setDensity('cards')}
              title="Card layout"
            >
              ▦ Cards
            </button>
            <button
              type="button"
              className={density === 'compact' ? 'is-active' : ''}
              onClick={() => setDensity('compact')}
              title="Compact layout"
            >
              ☰ Compact
            </button>
          </div>
          <button type="button" className="ghost-button" onClick={onReset}>
            Reset edits
          </button>
          <button type="button" className="ghost-button" onClick={onCopy}>
            Copy JSON
          </button>
          <button type="button" className="primary-button small-button" onClick={onDownload}>
            Download corrected JSON
          </button>
        </div>
      </div>

      <Section title="Entities">
        {!hasAnyEntities ? (
          <EmptyCard text="No usable entities were found." />
        ) : (
          entityGroups.map(
            (group) =>
              group.cards.length > 0 && (
                <PageGroup key={group.page ?? 'all'} page={group.page}>
                  <motion.div
                    className={density === 'compact' ? 'compact-list' : 'data-grid'}
                    variants={containerVariants}
                    initial="hidden"
                    animate="show"
                  >
                    {group.cards.map(({ entry, entryIndex, usableItems }, i) =>
                      density === 'compact' ? (
                        usableItems.slice(0, 8).map(({ item, itemIndex }) => {
                          const path = `entities.${entryIndex}.items.${itemIndex}.value`
                          return (
                            <motion.div className="compact-row" key={path} variants={cardVariants} custom={i}>
                              <span className="compact-icon" aria-hidden="true">
                                {iconForLabel(entry.category)}
                              </span>
                              <span className="compact-label">{entry.category || 'Entity'}</span>
                              <FieldValue
                                value={item.value ?? ''}
                                edited={editedPaths.has(path)}
                                verified={verifiedPaths.has(path)}
                                onCommit={(value) => onEdit(path, value)}
                                onToggleVerify={() => toggleVerified(path)}
                              />
                            </motion.div>
                          )
                        })
                      ) : (
                        <motion.div className="data-card" key={`${entryIndex}-${group.page}`} variants={cardVariants} custom={i}>
                          <strong>
                            <span className="card-icon" aria-hidden="true">
                              {iconForLabel(entry.category)}
                            </span>
                            {entry.category || 'Entity'}
                          </strong>
                          <div className="editable-list">
                            {usableItems.slice(0, 8).map(({ item, itemIndex }) => {
                              const path = `entities.${entryIndex}.items.${itemIndex}.value`
                              return (
                                <div className="editable-line" key={itemIndex}>
                                  <FieldValue
                                    value={item.value ?? ''}
                                    edited={editedPaths.has(path)}
                                    verified={verifiedPaths.has(path)}
                                    onCommit={(value) => onEdit(path, value)}
                                    onToggleVerify={() => toggleVerified(path)}
                                  />
                                </div>
                              )
                            })}
                          </div>
                        </motion.div>
                      )
                    )}
                  </motion.div>
                </PageGroup>
              )
          )
        )}
      </Section>

      <Section title="Key-value pairs">
        {!hasAnyKv ? (
          <EmptyCard text="No usable key-value pairs were found." />
        ) : (
          kvGroups.map(
            (group) =>
              group.cards.length > 0 && (
                <PageGroup key={group.page ?? 'all'} page={group.page}>
                  <motion.div
                    className={density === 'compact' ? 'compact-list' : 'data-grid'}
                    variants={containerVariants}
                    initial="hidden"
                    animate="show"
                  >
                    {group.cards.map(({ item, index }, i) => {
                      const path = `key_value_pairs.${index}.value`
                      return density === 'compact' ? (
                        <motion.div className="compact-row" key={path} variants={cardVariants} custom={i}>
                          <span className="compact-icon" aria-hidden="true">
                            {iconForLabel(item?.label)}
                          </span>
                          <span className="compact-label">{item?.label || 'Field'}</span>
                          <FieldValue
                            value={item?.value || ''}
                            edited={editedPaths.has(path)}
                            verified={verifiedPaths.has(path)}
                            onCommit={(value) => onEdit(path, value)}
                            onToggleVerify={() => toggleVerified(path)}
                          />
                        </motion.div>
                      ) : (
                        <motion.div className="data-card" key={path} variants={cardVariants} custom={i}>
                          <strong>
                            <span className="card-icon" aria-hidden="true">
                              {iconForLabel(item?.label)}
                            </span>
                            {item?.label || 'Field'}
                          </strong>
                          <FieldValue
                            value={item?.value || ''}
                            edited={editedPaths.has(path)}
                            verified={verifiedPaths.has(path)}
                            onCommit={(value) => onEdit(path, value)}
                            onToggleVerify={() => toggleVerified(path)}
                          />
                        </motion.div>
                      )
                    })}
                  </motion.div>
                </PageGroup>
              )
          )
        )}
      </Section>

      <Section title="Tables">
        {!hasAnyTables ? (
          <EmptyCard text="The model did not identify any usable tables in this document." title="No tables detected" />
        ) : (
          tableGroups.map(
            (group) =>
              group.cards.length > 0 && (
                <PageGroup key={group.page ?? 'all'} page={group.page}>
                  <div className="tables-list">
                    {group.cards.map(({ table, tableIndex, columns, usableRows }, i) => (
                      <motion.div
                        className="table-card"
                        key={`${tableIndex}-${group.page}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.05, 0.4), duration: 0.25 }}
                      >
                        <header>
                          <strong>{table.title || `Table ${tableIndex + 1}`}</strong>
                          {!isMultiPage && <span>Page {table.page || 1}</span>}
                        </header>
                        {columns.length > 0 && (
                          <div className="table-head">
                            {columns.map((column, ci) => (
                              <span key={ci}>{column}</span>
                            ))}
                          </div>
                        )}
                        <div className="table-grid">
                          {usableRows.length === 0 ? (
                            <div className="table-row">
                              <span>No rows available</span>
                            </div>
                          ) : (
                            usableRows.map(({ row, rowIndex }) => {
                              const cells = columns.length ? normalizeTableRow(row, columns.length) : Array.isArray(row) ? row : [row]
                              return (
                                <div className="table-row" key={rowIndex}>
                                  {cells.map((cell, cellIndex) => (
                                    <EditableSpan
                                      key={cellIndex}
                                      value={String(cell ?? '')}
                                      edited={editedPaths.has(`tables.${tableIndex}.rows.${rowIndex}.${cellIndex}`)}
                                      onCommit={(value) =>
                                        onEdit(`tables.${tableIndex}.rows.${rowIndex}.${cellIndex}`, value)
                                      }
                                    />
                                  ))}
                                </div>
                              )
                            })
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </PageGroup>
              )
          )
        )}
      </Section>
    </motion.article>
  )
}

function Badge({ children, className, delay, title }) {
  return (
    <motion.span
      className={className}
      title={title}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.25, ease: 'easeOut' }}
    >
      {children}
    </motion.span>
  )
}

function buildModelTooltip(processing) {
  if (!processing?.models_used?.length) return undefined
  const models = processing.models_used.join(', ')
  const tier = processing.quality_tier ? ` - file quality: ${processing.quality_tier}` : ''
  return `Processed with ${models}${tier}`
}

function Section({ title, children }) {
  return (
    <section className="output-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function EmptyCard({ title = 'None', text }) {
  return (
    <div className="data-card">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  )
}

function PageGroup({ page, children }) {
  if (page == null) return children
  return (
    <div className="page-group">
      <h4 className="page-group-heading">Page {page}</h4>
      {children}
    </div>
  )
}
