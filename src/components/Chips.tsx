import type { Front } from '../lib/api'
import { daysSince, relativeTime } from '../lib/wiki'

const TYPE_COLOR: Record<string, string> = {
  entity: 'var(--t-entity)',
  concept: 'var(--t-concept)',
  analysis: 'var(--t-analysis)',
  personal: 'var(--t-personal)',
  overview: 'var(--t-overview)',
}

const STATUS_COLOR: Record<string, string> = {
  active: 'var(--accent)',
  verified: 'var(--ok)',
  applied: 'var(--ok)',
  draft: 'var(--warn)',
  superseded: 'var(--ink-3)',
}

/** Matches the checker's "active pages rechecked within 60 days" budget. */
export const STALE_DAYS = 60

export function TypeChip({ type }: { type?: string | null }) {
  if (!type) return null
  return (
    <span
      className="chip"
      style={{ color: TYPE_COLOR[type] ?? 'var(--ink-2)' }}
    >
      {type}
    </span>
  )
}

export function FrontChips({
  front,
  compact = false,
}: {
  front: Front | null
  compact?: boolean
}) {
  if (!front)
    return (
      <span className="chip" style={{ color: 'var(--danger)' }}>
        no frontmatter
      </span>
    )
  const age = front.updated ? daysSince(front.updated) : null
  const stale = front.status === 'active' && age !== null && age > STALE_DAYS
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <TypeChip type={front.type} />
      {front.status && (
        <span
          className="chip"
          title={`status: ${front.status}`}
          style={{ color: STATUS_COLOR[front.status] ?? 'var(--ink-2)' }}
        >
          <span className="dot" />
          <span style={{ color: 'var(--ink-2)' }}>{front.status}</span>
        </span>
      )}
      {front.updated && !compact && (
        <span
          className="chip"
          title={
            stale
              ? `Active but not updated for ${age} days: recheck or trim it`
              : `updated ${front.updated}`
          }
          style={
            stale ? { color: 'var(--warn)', borderColor: 'currentColor' } : {}
          }
        >
          {stale ? 'stale · ' : 'updated '}
          {age === null
            ? front.updated
            : age < 1
              ? 'today'
              : relativeTime(front.updated)}
        </span>
      )}
    </span>
  )
}
