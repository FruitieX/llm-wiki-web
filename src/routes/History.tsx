import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { api, q, type Commit } from '../lib/api'
import { useHistory, useWiki } from '../lib/queries'
import { relativeTime } from '../lib/wiki'
import { Diff } from '../components/Diff'
import { Loading, Problem } from '../components/States'

export function History() {
  const { _splat: key = '' } = useParams({ strict: false }) as {
    _splat?: string
  }
  const { rev } = useSearch({ strict: false }) as { rev?: string }
  const navigate = useNavigate()
  const wiki = useWiki()
  const title = wiki.data?.pages.find((page) => page.key === key)?.title ?? key
  const path = `wiki/${key}.md`
  const history = useHistory(path)
  const commits = history.data?.commits ?? []
  const selected =
    commits.find((commit) => commit.hash === rev) ??
    (rev ? undefined : commits[0])

  if (history.isError)
    return (
      <Problem title="History could not be loaded">
        {history.error.message}
      </Problem>
    )

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-6 sm:px-8 lg:pt-10">
      <nav className="mb-3 flex items-center gap-1 text-sm text-ink-3">
        <Link to="/page/$" params={{ _splat: key }} className="hover:text-ink">
          {title}
        </Link>
        <ChevronRight size={13} />
        <span>History</span>
      </nav>
      <h1 className="mb-6 font-serif text-[1.7rem] font-semibold tracking-tight">
        History of {title}
      </h1>
      {!history.data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ol className={`space-y-1 ${rev ? 'hidden lg:block' : ''}`}>
            {commits.map((commit) => (
              <li key={commit.hash}>
                <button
                  onClick={() =>
                    navigate({
                      to: '/history/$',
                      params: { _splat: key },
                      search: { rev: commit.hash },
                      replace: !!rev,
                    })
                  }
                  className={`block w-full rounded-xl px-3 py-2.5 text-left transition ${
                    selected?.hash === commit.hash
                      ? 'bg-accent-soft'
                      : 'hover:bg-hover'
                  }`}
                >
                  <span className="block text-sm leading-snug">
                    {commit.subject}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {commit.author} · {relativeTime(commit.date)} ·{' '}
                    <span className="font-mono">{commit.hash.slice(0, 7)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className={`min-w-0 ${rev ? '' : 'hidden lg:block'}`}>
            {rev && (
              <button
                className="btn ghost mb-3 lg:hidden"
                onClick={() =>
                  navigate({
                    to: '/history/$',
                    params: { _splat: key },
                    search: { rev: undefined },
                  })
                }
              >
                <ArrowLeft size={15} /> All changes
              </button>
            )}
            {selected && <CommitDiff commit={selected} path={path} />}
          </div>
        </div>
      )}
    </div>
  )
}

function CommitDiff({ commit, path }: { commit: Commit; path: string }) {
  // The file's path at this commit, which differs from today's after a rename.
  const change = commit.files.find((file) => file.path.endsWith('.md')) ?? {
    path,
    previousPath: null,
    status: 'M',
  }
  const diff = useQuery({
    queryKey: ['diff', commit.hash, change.path],
    queryFn: () =>
      api<{ before: string | null; after: string | null }>(
        `/api/diff?rev=${commit.hash}&path=${q(change.path)}${change.previousPath ? `&previousPath=${q(change.previousPath)}` : ''}`,
      ),
    staleTime: Infinity,
  })
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-elev">
      <div className="border-b border-line px-4 py-3">
        <p className="font-medium">{commit.subject}</p>
        <p className="mt-0.5 text-xs text-ink-3">
          {commit.author} · {new Date(commit.date).toLocaleString()} ·{' '}
          <span className="font-mono">{commit.hash.slice(0, 10)}</span>
          {change.previousPath && (
            <>
              {' '}
              · moved from{' '}
              <span className="font-mono">{change.previousPath}</span>
            </>
          )}
        </p>
      </div>
      {!diff.data ? (
        <div className="p-4">
          <Loading />
        </div>
      ) : (
        <div className="scroll-thin overflow-x-auto py-1">
          <Diff before={diff.data.before ?? ''} after={diff.data.after ?? ''} />
        </div>
      )}
    </div>
  )
}
