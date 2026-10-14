import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useWiki } from '../lib/queries'
import { daysSince, FOLDERS, folderOf } from '../lib/wiki'
import { FrontChips, STALE_DAYS } from '../components/Chips'
import { Loading } from '../components/States'

type Sort = 'title' | 'updated'

export function AllPages() {
  const wiki = useWiki()
  const { filter } = useSearch({ strict: false }) as { filter?: string }
  const navigate = useNavigate()
  const [sort, setSort] = useState<Sort>('title')
  const filters = useMemo(() => {
    const folders = [
      ...new Set(
        wiki.data?.pages.map((page) => folderOf(page.key)).filter(Boolean),
      ),
    ].sort()
    return [
      { id: undefined, label: 'All' },
      ...folders.map((folder) => ({
        id: folder,
        label: FOLDERS[folder] ?? folder,
      })),
      { id: 'stale', label: 'Stale' },
      { id: 'draft', label: 'Drafts' },
    ]
  }, [wiki.data])
  const pages = useMemo(() => {
    const list = (wiki.data?.pages ?? []).filter((page) => {
      if (!filter) return true
      if (filter === 'stale') {
        const age = page.front?.updated ? daysSince(page.front.updated) : null
        return (
          page.front?.status === 'active' && age !== null && age > STALE_DAYS
        )
      }
      if (filter === 'draft') return page.front?.status === 'draft'
      return folderOf(page.key) === filter
    })
    return list.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : (b.front?.updated ?? '').localeCompare(a.front?.updated ?? '') ||
          a.title.localeCompare(b.title),
    )
  }, [wiki.data, filter, sort])

  return (
    <div className="mx-auto max-w-4xl px-5 pb-24 pt-8 sm:px-8 lg:pt-14">
      <h1 className="font-serif text-[2rem] font-semibold tracking-tight">
        All pages
      </h1>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {filters.map((item) => (
            <button
              key={item.label}
              onClick={() =>
                navigate({
                  to: '/pages',
                  search: { filter: item.id },
                  replace: true,
                })
              }
              className={`h-8 rounded-full border px-3 text-sm transition ${
                filter === item.id
                  ? 'border-accent bg-accent-soft text-ink'
                  : 'border-line text-ink-2 hover:bg-hover'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-3">
          Sort
          <select
            className="h-8 rounded-lg border border-line bg-elev px-2 text-ink"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="title">Title</option>
            <option value="updated">Last updated</option>
          </select>
        </label>
      </div>
      {!wiki.data ? (
        <div className="mt-8">
          <Loading />
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {pages.map((page) => (
            <li key={page.key}>
              <Link
                to="/page/$"
                params={{ _splat: page.key }}
                className="block py-3.5 transition hover:bg-hover sm:px-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-serif text-[1.05rem] font-semibold">
                    {page.title}
                  </span>
                  <span className="font-mono text-xs text-ink-3">
                    {page.key}
                  </span>
                  <span className="sm:ml-auto">
                    <FrontChips front={page.front} />
                  </span>
                </div>
                {page.summary && (
                  <p className="mt-1 line-clamp-2 text-sm text-ink-2">
                    {page.summary}
                  </p>
                )}
              </Link>
            </li>
          ))}
          {pages.length === 0 && (
            <li className="py-10 text-center text-ink-3">No pages match.</li>
          )}
        </ul>
      )}
    </div>
  )
}
