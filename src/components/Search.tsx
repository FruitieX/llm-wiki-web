import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FileText, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, q, type SearchHit } from '../lib/api'
import { useWiki } from '../lib/queries'
import { FrontChips } from './Chips'

function highlight(text: string, query: string): ReactNode {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return text
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  )
  return text
    .split(pattern)
    .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const debounced = useDebounced(query.trim(), 90)
  const navigate = useNavigate()
  const wiki = useWiki()
  const list = useRef<HTMLDivElement>(null)

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: ({ signal }) =>
      api<{ hits: SearchHit[] }>(`/api/search?q=${q(debounced)}&limit=40`, {
        signal,
      }),
    enabled: open && debounced.length > 0,
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  })

  // With an empty query, offer pages by title so the dialog doubles as a jump list.
  const hits: SearchHit[] = useMemo(() => {
    if (debounced) return search.data?.hits ?? []
    return [...(wiki.data?.pages ?? [])]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((page) => ({
        kind: 'page',
        key: page.key,
        title: page.title,
        snippet: page.summary,
        score: 0,
        front: page.front,
      }))
  }, [debounced, search.data, wiki.data])

  useEffect(() => setSelected(0), [debounced])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function go(hit: SearchHit) {
    onOpenChange(false)
    if (hit.kind === 'raw')
      navigate({ to: '/raw/$', params: { _splat: hit.key } })
    else navigate({ to: '/page/$', params: { _splat: hit.key } })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog search flex flex-col overflow-hidden p-0"
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelected((i) => Math.min(i + 1, hits.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((i) => Math.max(i - 1, 0))
            } else if (event.key === 'Enter' && hits[selected]) {
              event.preventDefault()
              go(hits[selected])
            }
          }}
        >
          <Dialog.Title className="sr-only">Search the wiki</Dialog.Title>
          <div
            className="flex items-center gap-2 border-b border-line px-4"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <SearchIcon size={18} className="shrink-0 text-ink-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and text…"
              className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-ink-3"
              enterKeyHint="go"
              aria-label="Search"
            />
            <Dialog.Close className="icon-btn -mr-2" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div
            ref={list}
            className="scroll-thin flex-1 overflow-y-auto p-2 sm:max-h-[60vh]"
          >
            {debounced && search.isSuccess && hits.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-ink-3">
                Nothing matches “{debounced}”.
              </p>
            )}
            {hits.map((hit, index) => (
              <button
                key={`${hit.kind}:${hit.key}`}
                data-index={index}
                onClick={() => go(hit)}
                onMouseMove={() => setSelected(index)}
                className={`block w-full rounded-xl px-3 py-2.5 text-left transition ${
                  index === selected ? 'bg-hover' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {hit.kind === 'raw' && (
                    <FileText size={14} className="shrink-0 text-ink-3" />
                  )}
                  <span className="truncate font-medium">
                    {highlight(hit.title, debounced)}
                  </span>
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    {hit.kind === 'raw' ? (
                      <span className="chip">raw</span>
                    ) : (
                      <FrontChips front={hit.front} compact />
                    )}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[0.72rem] text-ink-3">
                  {hit.key}
                </div>
                {hit.snippet && (
                  <p className="mt-1 line-clamp-2 text-sm text-ink-2">
                    {highlight(hit.snippet, debounced)}
                  </p>
                )}
              </button>
            ))}
          </div>
          <div className="hidden border-t border-line px-4 py-2 text-xs text-ink-3 sm:block">
            ↑↓ to move · Enter to open · Esc to close
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
