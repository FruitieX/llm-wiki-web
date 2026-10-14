import { Link } from '@tanstack/react-router'
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkWikiLinks, slugify, uniqueId } from '../lib/wiki'

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** The source offset of the task-list item being rendered. */
const TaskOffset = createContext<number | null>(null)

const urlTransform = (url: string) =>
  url.startsWith('wiki:') || url.startsWith('rawfile:')
    ? url
    : defaultUrlTransform(url)

/**
 * Renders a page body. `keys` is every page in the wiki, so links to missing
 * pages can be marked broken; `rawPaths` does the same for raw citations.
 */
export const Markdown = memo(function Markdown({
  text,
  keys,
  titles,
  onToggleTask,
  rawPaths,
  compact = false,
  currentKey,
}: {
  text: string
  keys: Set<string>
  /** Page titles, shown for links written without a label. */
  titles?: Map<string, string>
  /** Makes task-list checkboxes clickable; gets the item's offset in `text`. */
  onToggleTask?: (offset: number) => void
  rawPaths?: Set<string>
  compact?: boolean
  currentKey?: string
}) {
  const components = useMemo<Components>(() => {
    const seen = new Map<string, number>()
    const heading =
      (Tag: 'h2' | 'h3' | 'h4') =>
      ({ children }: { children?: ReactNode }) => (
        <Tag id={uniqueId(slugify(textOf(children)), seen)}>{children}</Tag>
      )
    return {
      h1: heading('h2'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      li: ({ node, className, children }) => {
        const offset = node?.position?.start.offset
        const item = <li className={className}>{children}</li>
        return className?.includes('task-list-item') && offset !== undefined ? (
          <TaskOffset.Provider value={offset}>{item}</TaskOffset.Provider>
        ) : (
          item
        )
      },
      input: function TaskBox({ type, checked }) {
        const offset = useContext(TaskOffset)
        if (type !== 'checkbox') return <input type={type} />
        const enabled = !!onToggleTask && offset !== null
        return (
          <input
            type="checkbox"
            checked={!!checked}
            disabled={!enabled}
            onChange={() => enabled && onToggleTask!(offset!)}
            aria-label={checked ? 'Mark as not done' : 'Mark as done'}
          />
        )
      },
      table: ({ children }) => (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      ),
      a: ({ href = '', children }) => {
        if (href.startsWith('wiki:')) {
          const [key, anchor] = href.slice(5).split('#')
          const broken = !keys.has(key)
          const unlabeled = textOf(children) === key
          return (
            <Link
              to="/page/$"
              params={{ _splat: key }}
              hash={anchor}
              className={`wiki-link${broken ? ' broken' : ''}`}
              title={broken ? `Missing page: ${key}` : key}
            >
              {unlabeled && titles?.get(key) ? titles.get(key) : children}
            </Link>
          )
        }
        if (href.startsWith('rawfile:')) {
          const path = href.slice(8)
          const missing = rawPaths ? !rawPaths.has(path) : false
          return (
            <Link
              to="/raw/$"
              params={{ _splat: path }}
              className={`raw-link${missing ? ' missing' : ''}`}
              title={missing ? `Missing raw file: ${path}` : path}
            >
              {children}
            </Link>
          )
        }
        if (href.startsWith('#')) return <a href={href}>{children}</a>
        // A relative Markdown link to another page, e.g. ../concepts/x.md
        const relative = href.match(/^(?!\w+:)([^#?]+)\.md(#.*)?$/)
        if (relative && currentKey) {
          const base = currentKey.split('/').slice(0, -1)
          for (const part of relative[1].split('/')) {
            if (part === '..') base.pop()
            else if (part !== '.') base.push(part)
          }
          const key = base.join('/')
          return (
            <Link
              to="/page/$"
              params={{ _splat: key }}
              className={`wiki-link${keys.has(key) ? '' : ' broken'}`}
            >
              {children}
            </Link>
          )
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="external"
          >
            {children}
          </a>
        )
      },
    }
    // The heading id counter must restart on every render of new text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, titles, rawPaths, currentKey, text, onToggleTask])
  return (
    <div className={`prose-wiki${compact ? ' compact' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiLinks]}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
