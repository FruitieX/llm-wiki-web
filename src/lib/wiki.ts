import { visit, SKIP } from 'unist-util-visit'

/** Same pattern as tools/wiki_check.js, with the anchor and label captured. */
export const LINK_RE = /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g

export function normalizeKey(target: string) {
  return target.trim().replace(/^\//, '').replace(/\.md$/, '')
}

export const FOLDERS: Record<string, string> = {
  entities: 'Entities',
  concepts: 'Concepts',
  analyses: 'Analyses',
  personal: 'Personal',
}

export function folderOf(key: string) {
  const at = key.indexOf('/')
  return at < 0 ? '' : key.slice(0, at)
}

export function splitFrontmatter(text: string) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return { front: '', body: text }
  return { front: match[0], body: text.slice(match[0].length) }
}

/** Removes the first `# Title` line, which the page header shows instead. */
export function stripTitle(body: string) {
  return body.replace(/^\s*# .*\n?/, '')
}

export function today() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function setUpdated(text: string, date = today()) {
  const { front, body } = splitFrontmatter(text)
  if (!front) return text
  const next = /^updated:.*$/m.test(front)
    ? front.replace(/^updated:.*$/m, `updated: ${date}`)
    : front.replace(/\n---\n$/, `\nupdated: ${date}\n---\n`)
  return next + body
}

/** The `<area>` in `docs(<area>): …`, following the wiki's commit history. */
export function areaFor(key: string) {
  const last = key.split('/').pop() ?? key
  return last === 'index' ? 'wiki' : last
}

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export type Heading = { depth: number; text: string; id: string }
export function headings(body: string): Heading[] {
  const out: Heading[] = []
  let code = false
  const seen = new Map<string, number>()
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) code = !code
    if (code) continue
    const match = line.match(/^(#{2,3})\s+(.*?)\s*#*\s*$/)
    if (!match) continue
    const text = match[2]
      .replace(LINK_RE, (_, key, _a, label) => label ?? key)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
    out.push({
      depth: match[1].length,
      text,
      id: uniqueId(slugify(text), seen),
    })
  }
  return out
}

export function uniqueId(base: string, seen: Map<string, number>) {
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count ? `${base}-${count}` : base
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function relativeTime(date: string | number | Date) {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return rtf.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function daysSince(date: string) {
  const parsed = Date.parse(date)
  if (Number.isNaN(parsed)) return null
  return Math.floor((Date.now() - parsed) / 86400000)
}

/**
 * A remark plugin: `[[key#anchor|label]]` becomes a link with a `wiki:` URL,
 * and inline code naming a `raw/…` file becomes a link to the raw viewer.
 */
export function remarkWikiLinks() {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined || parent.type === 'link') return
      const value: string = node.value
      LINK_RE.lastIndex = 0
      if (!LINK_RE.test(value)) return
      LINK_RE.lastIndex = 0
      const parts: any[] = []
      let last = 0
      for (const match of value.matchAll(LINK_RE)) {
        const at = match.index ?? 0
        if (at > last)
          parts.push({ type: 'text', value: value.slice(last, at) })
        const key = normalizeKey(match[1])
        const anchor = match[2] ?? ''
        parts.push({
          type: 'link',
          url: `wiki:${key}${anchor}`,
          children: [{ type: 'text', value: match[3] ?? key }],
        })
        last = at + match[0].length
      }
      if (last < value.length)
        parts.push({ type: 'text', value: value.slice(last) })
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
    visit(
      tree,
      'inlineCode',
      (node: any, index: number | undefined, parent: any) => {
        if (!parent || index === undefined || parent.type === 'link') return
        if (!/^raw\/\S+$/.test(node.value)) return
        parent.children.splice(index, 1, {
          type: 'link',
          url: `rawfile:${node.value}`,
          children: [{ ...node }],
        })
        return SKIP
      },
    )
  }
}

/** The `[[` completion candidates: every page key, best match first. */
export function rankKeys(
  pages: { key: string; title: string }[],
  query: string,
): { key: string; title: string }[] {
  const needle = query.toLowerCase()
  if (!needle) return pages
  return pages
    .map((page) => {
      const key = page.key.toLowerCase()
      const title = page.title.toLowerCase()
      const last = key.split('/').pop() ?? key
      const score = last.startsWith(needle)
        ? 0
        : key.startsWith(needle)
          ? 1
          : title.startsWith(needle)
            ? 2
            : key.includes(needle)
              ? 3
              : title.includes(needle)
                ? 4
                : -1
      return { page, score }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.page.key.localeCompare(b.page.key))
    .map((entry) => entry.page)
}
