import { diffLines, diffWordsWithSpace } from 'diff'
import { Fragment, useMemo, type ReactNode } from 'react'

type Row =
  | {
      kind: 'same' | 'add' | 'del'
      text: string
      old?: number
      new?: number
      inline?: ReactNode
    }
  | { kind: 'hunk'; text: string }

const CONTEXT = 3

function lines(value: string) {
  const out = value.split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

function inline(before: string, after: string, side: 'del' | 'add'): ReactNode {
  return diffWordsWithSpace(before, after).map((part, i) => {
    if (side === 'del' && part.added) return null
    if (side === 'add' && part.removed) return null
    if (part.added) return <ins key={i}>{part.value}</ins>
    if (part.removed) return <del key={i}>{part.value}</del>
    return <Fragment key={i}>{part.value}</Fragment>
  })
}

export function buildRows(before: string, after: string): Row[] {
  const rows: Row[] = []
  let oldLine = 1
  let newLine = 1
  const parts = diffLines(before, after)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const text = lines(part.value)
    if (part.removed && parts[i + 1]?.added) {
      const added = lines(parts[i + 1].value)
      const pairs = Math.min(text.length, added.length)
      text.forEach((line, j) =>
        rows.push({
          kind: 'del',
          text: line,
          old: oldLine++,
          inline: j < pairs ? inline(line, added[j], 'del') : undefined,
        }),
      )
      added.forEach((line, j) =>
        rows.push({
          kind: 'add',
          text: line,
          new: newLine++,
          inline: j < pairs ? inline(text[j], line, 'add') : undefined,
        }),
      )
      i++
    } else if (part.removed)
      text.forEach((line) =>
        rows.push({ kind: 'del', text: line, old: oldLine++ }),
      )
    else if (part.added)
      text.forEach((line) =>
        rows.push({ kind: 'add', text: line, new: newLine++ }),
      )
    else
      text.forEach((line) =>
        rows.push({ kind: 'same', text: line, old: oldLine++, new: newLine++ }),
      )
  }
  // Fold long unchanged runs, keeping a little context around each change.
  const keep = rows.map(() => false)
  rows.forEach((row, index) => {
    if (row.kind === 'same') return
    for (
      let j = Math.max(0, index - CONTEXT);
      j <= Math.min(rows.length - 1, index + CONTEXT);
      j++
    )
      keep[j] = true
  })
  const out: Row[] = []
  let skipped = 0
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (skipped)
        out.push({
          kind: 'hunk',
          text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}`,
        })
      skipped = 0
      out.push(row)
    } else skipped++
  })
  if (skipped && out.length)
    out.push({
      kind: 'hunk',
      text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}`,
    })
  return out
}

export function Diff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => buildRows(before, after), [before, after])
  if (!rows.length)
    return <p className="p-4 text-sm text-ink-3">No changes to the text.</p>
  return (
    <div className="diff">
      {rows.map((row, index) =>
        row.kind === 'hunk' ? (
          <div key={index} className="hunk">
            ⋯ {row.text}
          </div>
        ) : (
          <div
            key={index}
            className={`row ${row.kind === 'same' ? '' : row.kind}`}
          >
            <span className="num old">{row.old ?? ''}</span>
            <span className="num">{row.new ?? row.old ?? ''}</span>
            <span className="sign">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </span>
            <span className="text">{row.inline ?? row.text}</span>
          </div>
        ),
      )}
    </div>
  )
}
