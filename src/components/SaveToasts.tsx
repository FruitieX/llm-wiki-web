import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Check, LoaderCircle, X } from 'lucide-react'
import { useEffect } from 'react'
import { dismissSave, useSaves, type TrackedSave } from '../lib/saves'

/** Bottom-of-screen progress for saves on their way to GitHub. */
export function SaveToasts() {
  const saves = useSaves()
  if (!saves.length) return null
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-3"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.9rem)' }}
      aria-live="polite"
    >
      {saves.slice(-3).map((save) => (
        <Toast key={save.id} save={save} />
      ))}
    </div>
  )
}

function Toast({ save }: { save: TrackedSave }) {
  const navigate = useNavigate()
  useEffect(() => {
    if (save.state !== 'pushed') return
    const id = setTimeout(
      () => dismissSave(save.id),
      save.warnings.length ? 9000 : 3500,
    )
    return () => clearTimeout(id)
  }, [save.state, save.id, save.warnings.length])
  const failed = save.state === 'failed'
  return (
    <div
      className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-soft backdrop-blur ${
        failed ? 'border-warn/40 bg-warn-soft' : 'border-line bg-elev/95'
      }`}
      style={{ animation: 'rise-toast 0.18s ease-out' }}
    >
      <span className="mt-0.5 shrink-0">
        {save.state === 'pushing' ? (
          <LoaderCircle size={16} className="animate-spin text-ink-3" />
        ) : failed ? (
          <AlertTriangle size={16} className="text-warn" />
        ) : (
          <Check size={16} className="text-ok" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {save.state === 'pushing'
            ? `Saving ${save.title}…`
            : failed
              ? `${save.title} was not saved`
              : 'Saved'}
        </p>
        {save.state === 'pushed' && save.subject && (
          <p className="truncate font-mono text-xs text-ink-3">
            {save.subject}
          </p>
        )}
        {failed && <p className="mt-0.5 text-ink-2">{save.error}</p>}
        {save.warnings.length > 0 && save.state !== 'failed' && (
          <ul className="mt-1 space-y-0.5 text-xs text-warn">
            {save.warnings.slice(0, 3).map((warning) => (
              <li key={warning} className="line-clamp-2">
                {warning}
              </li>
            ))}
          </ul>
        )}
        {failed && save.draftKey && (
          <button
            className="mt-1.5 font-medium text-accent underline"
            onClick={() => {
              dismissSave(save.id)
              if (save.draftKey === 'new')
                navigate({
                  to: '/new',
                  search: {
                    name: save.key,
                    folder: undefined,
                    template: undefined,
                  },
                })
              else navigate({ to: '/edit/$', params: { _splat: save.key } })
            }}
          >
            Open your edit
          </button>
        )}
      </div>
      {save.state !== 'pushing' && (
        <button
          onClick={() => dismissSave(save.id)}
          aria-label="Dismiss"
          className="shrink-0 text-ink-3 hover:text-ink"
        >
          <X size={15} />
        </button>
      )}
    </div>
  )
}
