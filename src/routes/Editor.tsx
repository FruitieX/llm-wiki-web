import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import {
  useBlocker,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Columns2,
  Eye,
  FolderInput,
  GitMerge,
  PenLine,
  X,
} from 'lucide-react'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  api,
  ApiError,
  type CheckDelta,
  type Committed,
  type ConflictDetails,
  type PageDetail,
} from '../lib/api'
import { usePage, usePageKeys, usePageTitles, useWiki } from '../lib/queries'
import {
  areaFor,
  FOLDERS,
  setUpdated,
  splitFrontmatter,
  stripTitle,
  today,
} from '../lib/wiki'
import { CodeEditor, type Completions } from '../components/CodeEditor'
import { Markdown } from '../components/Markdown'
import { Loading, NotFound, Problem } from '../components/States'

type Draft = { text: string; baseBlob: string | null; savedAt: number }
const draftKey = (key: string) => `llm-wiki-draft:${key}`

function readDraft(key: string): Draft | null {
  try {
    return JSON.parse(localStorage.getItem(draftKey(key)) ?? 'null')
  } catch {
    return null
  }
}
function writeDraft(key: string, draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(draftKey(key), JSON.stringify(draft))
    else localStorage.removeItem(draftKey(key))
  } catch {}
}

type View = 'write' | 'preview' | 'split'

export default function Editor({ mode }: { mode: 'edit' | 'new' }) {
  const { _splat: key = '' } = useParams({ strict: false }) as {
    _splat?: string
  }
  const page = usePage(mode === 'edit' ? key : '')
  if (mode === 'new') return <EditorBody mode="new" />
  if (page.isError)
    return page.error instanceof ApiError && page.error.status === 404 ? (
      <NotFound />
    ) : (
      <Problem title="This page could not be loaded">
        {page.error.message}
      </Problem>
    )
  if (!page.data)
    return (
      <div className="mx-auto max-w-3xl px-5 py-10">
        <Loading />
      </div>
    )
  return <EditorBody key={key} mode="edit" page={page.data} />
}

function templateText(template: string, title: string) {
  return setUpdated(
    template.replace(/^# .*$/m, `# ${title || 'Untitled'}`),
    today(),
  )
}

function titleFromSlug(slug: string) {
  const words = slug.split('-').filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function EditorBody({
  mode,
  page,
}: {
  mode: 'edit' | 'new'
  page?: PageDetail
}) {
  const wiki = useWiki()
  const keys = usePageKeys()
  const titles = usePageTitles()
  const client = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as {
    folder?: string
    template?: string
    name?: string
  }
  const storageKey = mode === 'edit' ? page!.key : 'new'

  // New-page fields.
  const initialName = search.name ?? ''
  const [folder, setFolder] = useState(
    search.folder ??
      (initialName.includes('/') ? initialName.split('/')[0] : 'entities'),
  )
  const [slug, setSlug] = useState(
    initialName.includes('/')
      ? initialName.split('/').slice(1).join('/')
      : initialName,
  )
  const [templateName, setTemplateName] = useState(
    search.template ??
      (folder === 'entities' ? 'entity' : folder.replace(/s$/, '')),
  )

  const templates = wiki.data?.templates ?? []
  const template =
    templates.find((item) => item.name === templateName) ?? templates[0]
  const newKey = `${folder ? `${folder}/` : ''}${slug}`

  const [restored] = useState(() => readDraft(storageKey))
  const pristine =
    mode === 'edit'
      ? page!.text
      : template
        ? templateText(template.text, titleFromSlug(slug))
        : ''
  const useRestored = !!restored && restored.text !== pristine
  const [text, setText] = useState(useRestored ? restored!.text : pristine)
  const [baseBlob, setBaseBlob] = useState<string | null>(
    useRestored && restored!.baseBlob
      ? restored!.baseBlob
      : (page?.blob ?? null),
  )
  const [draftNotice, setDraftNotice] = useState(
    useRestored ? restored!.savedAt : null,
  )
  const [touched, setTouched] = useState(useRestored)
  const [view, setView] = useState<View>(() =>
    window.matchMedia('(min-width: 1024px)').matches ? 'split' : 'write',
  )
  const [saveOpen, setSaveOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [conflict, setConflict] = useState<{
    details: ConflictDetails
    mine: string
  } | null>(null)
  const dirty = touched && text !== pristine

  // Keep the template in step with the chosen name until the owner types.
  useEffect(() => {
    if (mode === 'new' && !touched && template)
      setText(templateText(template.text, titleFromSlug(slug)))
  }, [mode, touched, template, slug])

  // Persist the draft so a reload, crash or dead battery loses nothing.
  useEffect(() => {
    if (!touched) return
    const id = setTimeout(
      () =>
        writeDraft(
          storageKey,
          dirty ? { text, baseBlob, savedAt: Date.now() } : null,
        ),
      400,
    )
    return () => clearTimeout(id)
  }, [text, baseBlob, touched, dirty, storageKey])

  const leaving = useRef(false)
  useBlocker({
    shouldBlockFn: () =>
      dirty &&
      !leaving.current &&
      !window.confirm('Leave the editor? Your draft is kept on this device.'),
    enableBeforeUnload: () => dirty && !leaving.current,
  })

  const completions = useCallback(
    (): Completions => ({
      pages:
        wiki.data?.pages.map((p) => ({ key: p.key, title: p.title })) ?? [],
      raw: wiki.data?.raw.map((file) => file.path) ?? [],
    }),
    [wiki.data],
  )

  const deferred = useDeferredValue(text)
  const preview = useMemo(() => {
    const { body } = splitFrontmatter(deferred)
    const title = body.match(/^\s*# (.*)$/m)?.[1]
    return { title, body: stripTitle(body) }
  }, [deferred])
  const rawPaths = useMemo(
    () => new Set(wiki.data?.raw.map((file) => file.path)),
    [wiki.data],
  )
  // Links to the page being created should not show as broken in its own preview.
  const previewKeys = useMemo(
    () => (mode === 'new' ? new Set([...keys, newKey]) : keys),
    [keys, mode, newKey],
  )

  const upstreamMoved =
    mode === 'edit' && baseBlob !== null && page!.blob !== baseBlob

  function finish(destination: string) {
    leaving.current = true
    writeDraft(storageKey, null)
    client.invalidateQueries()
    navigate({ to: '/page/$', params: { _splat: destination } })
  }

  const close = () => {
    if (mode === 'edit')
      navigate({ to: '/page/$', params: { _splat: page!.key } })
    else navigate({ to: '/' })
  }

  const viewButtons: {
    id: View
    icon: typeof Eye
    label: string
    desktop?: boolean
  }[] = [
    { id: 'write', icon: PenLine, label: 'Write' },
    { id: 'split', icon: Columns2, label: 'Split', desktop: true },
    { id: 'preview', icon: Eye, label: 'Preview' },
  ]

  return (
    <div className="flex h-dvh flex-col">
      <header
        className="flex shrink-0 items-center gap-1.5 border-b border-line bg-bg px-2 sm:px-4"
        style={{ paddingTop: 'env(safe-area-inset-top)', minHeight: '3.5rem' }}
      >
        <button
          className="icon-btn"
          onClick={close}
          aria-label="Close the editor"
        >
          <ArrowLeft size={19} />
        </button>
        <div className="min-w-0 flex-1">
          {mode === 'edit' ? (
            <>
              <p className="truncate text-sm font-semibold">{page!.title}</p>
              <p className="truncate font-mono text-[0.7rem] text-ink-3">
                {page!.key}
                {dirty && (
                  <span className="ml-2 font-sans text-warn">● unsaved</span>
                )}
              </p>
            </>
          ) : (
            <p className="text-sm font-semibold">New page</p>
          )}
        </div>
        <div
          className="flex rounded-lg border border-line p-0.5"
          role="tablist"
          aria-label="Editor view"
        >
          {viewButtons.map(({ id, icon: Icon, label, desktop }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`${desktop ? 'hidden lg:flex' : 'flex'} h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                view === id
                  ? 'bg-accent-soft text-ink'
                  : 'text-ink-3 hover:text-ink'
              }`}
              title={label}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        {mode === 'edit' && !['index', 'agent-start'].includes(page!.key) && (
          <button
            className="icon-btn"
            onClick={() => setMoveOpen(true)}
            title="Rename or move"
            aria-label="Rename or move"
          >
            <FolderInput size={18} />
          </button>
        )}
        <button
          className="btn primary"
          onClick={() => setSaveOpen(true)}
          disabled={(mode === 'edit' && !dirty) || (mode === 'new' && !slug)}
        >
          <Check size={16} /> Save
        </button>
      </header>

      {mode === 'new' && (
        <NewPageFields
          folder={folder}
          setFolder={setFolder}
          slug={slug}
          setSlug={setSlug}
          templateName={template?.name ?? ''}
          setTemplateName={setTemplateName}
          templates={templates.map((item) => item.name)}
          exists={keys.has(newKey)}
          touched={touched}
        />
      )}

      {draftNotice && (
        <Banner tone="info" onClose={() => setDraftNotice(null)}>
          Restored your unsaved draft from{' '}
          {new Date(draftNotice).toLocaleString()}.{' '}
          <button
            className="font-medium underline"
            onClick={() => {
              setText(pristine)
              setBaseBlob(page?.blob ?? null)
              setTouched(false)
              writeDraft(storageKey, null)
              setDraftNotice(null)
            }}
          >
            Discard it
          </button>
        </Banner>
      )}
      {upstreamMoved && (
        <Banner tone="warn">
          This page changed upstream since you started editing. Saving will show
          both versions so you can merge them.
        </Banner>
      )}

      <div className="flex min-h-0 flex-1">
        <section
          className={`min-w-0 flex-1 overflow-y-auto ${view === 'preview' ? 'hidden' : ''} ${view === 'split' ? 'border-r border-line' : ''}`}
        >
          <CodeEditor
            value={text}
            onChange={(value) => {
              setText(value)
              setTouched(true)
            }}
            onSave={() =>
              (mode === 'new' ? !!slug : dirty) && setSaveOpen(true)
            }
            completions={completions}
            autoFocus={
              !draftNotice && window.matchMedia('(pointer: fine)').matches
            }
          />
        </section>
        <section
          className={`scroll-thin min-w-0 flex-1 overflow-y-auto bg-elev ${view === 'write' ? 'hidden' : ''}`}
        >
          <div className="mx-auto max-w-[44rem] px-5 py-8 sm:px-8">
            <h1 className="mb-6 font-serif text-[1.9rem] font-semibold leading-tight tracking-tight">
              {preview.title ?? <span className="text-ink-3">Untitled</span>}
            </h1>
            <Markdown
              text={preview.body}
              keys={previewKeys}
              titles={titles}
              rawPaths={rawPaths}
              compact
              currentKey={mode === 'edit' ? page!.key : newKey}
            />
          </div>
        </section>
      </div>

      <SaveDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        mode={mode}
        pageKey={mode === 'edit' ? page!.key : newKey}
        text={text}
        baseBlob={baseBlob}
        sections={wiki.data?.sections ?? []}
        folder={folder}
        onSaved={(result, finalText, destination) => {
          setText(finalText)
          finish(destination)
          void result
        }}
        onConflict={(details) => {
          setSaveOpen(false)
          setConflict({ details, mine: text })
        }}
      />
      {mode === 'edit' && (
        <MoveDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          page={page!}
          dirty={dirty}
          backlinks={page!.backlinks.length}
          onMoved={(to) => finish(to)}
        />
      )}
      {conflict && (
        <MergeDialog
          conflict={conflict}
          onCancel={() => setConflict(null)}
          onResolve={(merged, blob) => {
            setText(merged)
            setBaseBlob(blob)
            setTouched(true)
            setConflict(null)
            setSaveOpen(true)
          }}
        />
      )}
    </div>
  )
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: 'info' | 'warn'
  children: React.ReactNode
  onClose?: () => void
}) {
  return (
    <div
      className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 text-sm ${
        tone === 'warn'
          ? 'border-warn/30 bg-warn-soft text-ink'
          : 'border-line bg-accent-soft text-ink'
      }`}
    >
      {tone === 'warn' && (
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
      )}
      <div className="flex-1">{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="text-ink-3 hover:text-ink"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}

function NewPageFields(props: {
  folder: string
  setFolder: (value: string) => void
  slug: string
  setSlug: (value: string) => void
  templateName: string
  setTemplateName: (value: string) => void
  templates: string[]
  exists: boolean
  touched: boolean
}) {
  const valid = !props.slug || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(props.slug)
  return (
    <div className="shrink-0 border-b border-line bg-elev px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="new-folder">
            Folder
          </label>
          <select
            id="new-folder"
            className="field h-9 w-auto"
            value={props.folder}
            onChange={(e) => props.setFolder(e.target.value)}
          >
            {Object.entries(FOLDERS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
            <option value="">Top level</option>
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor="new-slug">
            File name
          </label>
          <div className="flex items-center gap-1 font-mono text-sm">
            <span className="text-ink-3">
              {props.folder ? `${props.folder}/` : ''}
            </span>
            <input
              id="new-slug"
              className="field h-9 font-mono"
              value={props.slug}
              onChange={(e) =>
                props.setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))
              }
              placeholder="kebab-case-name"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="text-ink-3">.md</span>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="new-template">
            Template
          </label>
          <select
            id="new-template"
            className="field h-9 w-auto"
            value={props.templateName}
            onChange={(e) => props.setTemplateName(e.target.value)}
            disabled={props.touched}
            title={
              props.touched
                ? 'The template applies until you start writing'
                : undefined
            }
          >
            {props.templates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {(!valid || props.exists) && (
        <p className="mx-auto mt-2 max-w-5xl text-sm text-danger">
          {props.exists
            ? 'A page with that path already exists.'
            : 'Use lowercase letters, digits and single hyphens.'}
        </p>
      )}
    </div>
  )
}

function CheckList({ check }: { check: CheckDelta }) {
  return (
    <div className="space-y-2 text-sm">
      {check.errors.map((error) => (
        <p
          key={error}
          className="flex gap-2 rounded-lg bg-danger-soft px-3 py-2 text-danger"
        >
          <X size={15} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      ))}
      {check.warnings.map((warning) => (
        <p
          key={warning}
          className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          <span className="break-words">{warning}</span>
        </p>
      ))}
      {check.existingErrors.length > 0 && (
        <details className="text-ink-3">
          <summary className="cursor-pointer">
            {check.existingErrors.length} existing error
            {check.existingErrors.length > 1 ? 's' : ''} elsewhere (not
            blocking)
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {check.existingErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function SaveDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'edit' | 'new'
  pageKey: string
  text: string
  baseBlob: string | null
  sections: string[]
  folder: string
  onSaved: (result: Committed, text: string, destination: string) => void
  onConflict: (details: ConflictDetails) => void
}) {
  const { open, mode, pageKey, text } = props
  const area = areaFor(pageKey)
  // Until the owner types a message, it follows the page path.
  const [typed, setMessage] = useState<string | null>(null)
  const message =
    typed ?? (mode === 'new' ? `docs(${area}): add page` : `docs(${area}): `)
  const [bump, setBump] = useState(true)
  const defaultSection =
    FOLDERS[props.folder] && props.sections.includes(FOLDERS[props.folder])
      ? FOLDERS[props.folder]
      : (props.sections[0] ?? '')
  const [section, setSection] = useState(defaultSection)
  const [description, setDescription] = useState('')
  const [check, setCheck] = useState<CheckDelta | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const finalText = bump ? setUpdated(text) : text

  useEffect(() => {
    if (!open) return
    setError(null)
    setSection((current) => current || defaultSection)
  }, [open, defaultSection])

  // Validate with the wiki's own checker whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setChecking(true)
    setCheck(null)
    api<{ check: CheckDelta }>('/api/check', {
      method: 'POST',
      body: { changes: [{ key: pageKey, text: finalText }] },
      signal: controller.signal,
    })
      .then((result) => setCheck(result.check))
      .catch((e) => {
        if ((e as Error).name !== 'AbortError')
          setError(e instanceof ApiError ? e.message : 'The check failed.')
      })
      .finally(() => setChecking(false))
    return () => controller.abort()
  }, [open, pageKey, finalText])

  // The checker warns about pages missing from index.md; a new page with an
  // index section will be listed, so leave that warning out.
  const shown = check && {
    ...check,
    warnings: check.warnings.filter(
      (w) =>
        !(
          mode === 'new' &&
          section &&
          w.startsWith('not listed in wiki/index.md')
        ),
    ),
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const result =
        mode === 'edit'
          ? await api<Committed>('/api/page', {
              method: 'PUT',
              body: {
                key: pageKey,
                text: finalText,
                baseBlob: props.baseBlob,
                message,
              },
            })
          : await api<Committed>('/api/page', {
              method: 'POST',
              body: {
                key: pageKey,
                text: finalText,
                section: section || null,
                description,
                message,
              },
            })
      props.onSaved(result, finalText, pageKey)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details?.path)
        props.onConflict(e.details)
      else if (e instanceof ApiError && e.status === 422 && e.details?.check)
        setCheck(e.details.check)
      else setError(e instanceof ApiError ? e.message : 'Saving failed.')
    } finally {
      setBusy(false)
    }
  }

  const subjectOk =
    message.trim().length > 0 && !/^docs\([^)]*\):\s*$/.test(message.trim())
  return (
    <Dialog.Root open={open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog p-5" aria-describedby={undefined}>
          <Dialog.Title className="font-serif text-lg font-semibold">
            {mode === 'new' ? 'Create page' : 'Save changes'}
          </Dialog.Title>
          <p className="mt-1 font-mono text-xs text-ink-3">wiki/{pageKey}.md</p>
          <div className="mt-4 space-y-4">
            <div>
              <label className="label" htmlFor="commit-message">
                Commit message
              </label>
              <input
                id="commit-message"
                className="field font-mono text-sm"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    subjectOk &&
                    !busy &&
                    !checking &&
                    !check?.errors.length
                  )
                    save()
                }}
                autoFocus
                autoCapitalize="off"
              />
            </div>
            {mode === 'new' && (
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <div>
                  <label className="label" htmlFor="index-section">
                    Index section
                  </label>
                  <select
                    id="index-section"
                    className="field"
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                  >
                    {props.sections.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                    <option value="">Don't list it</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="index-description">
                    Index description
                  </label>
                  <input
                    id="index-description"
                    className="field"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="One line on what the page covers."
                    disabled={!section}
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={bump}
                onChange={(e) => setBump(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Set{' '}
              <code className="rounded bg-sunk px-1 font-mono text-xs">
                updated
              </code>{' '}
              to {today()}
            </label>
            <div>
              <p className="label">Wiki check</p>
              {checking ? (
                <p className="text-sm text-ink-3">
                  Running tools/wiki_check.js…
                </p>
              ) : shown ? (
                shown.errors.length ||
                shown.warnings.length ||
                shown.existingErrors.length ? (
                  <CheckList check={shown} />
                ) : (
                  <p className="flex items-center gap-1.5 text-sm text-ok">
                    <Check size={15} /> No new errors or warnings.
                  </p>
                )
              ) : null}
            </div>
            {error && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="btn ghost">Keep editing</Dialog.Close>
            <button
              className="btn primary"
              onClick={save}
              disabled={
                busy || checking || !subjectOk || !!check?.errors.length
              }
            >
              {busy ? 'Committing…' : 'Commit and push'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function MoveDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  page: PageDetail
  dirty: boolean
  backlinks: number
  onMoved: (to: string) => void
}) {
  const [to, setTo] = useState(props.page.key)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (props.open)
      setMessage(`docs(${areaFor(to)}): move ${props.page.key} to ${to}`)
  }, [props.open, to, props.page.key])

  async function move() {
    setBusy(true)
    setError(null)
    try {
      await api('/api/page/move', {
        method: 'POST',
        body: { from: props.page.key, to, baseBlob: props.page.blob, message },
      })
      props.onMoved(to)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Moving failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog p-5" aria-describedby={undefined}>
          <Dialog.Title className="font-serif text-lg font-semibold">
            Rename or move
          </Dialog.Title>
          <p className="mt-1 text-sm text-ink-2">
            Every link to this page ({props.backlinks} page
            {props.backlinks === 1 ? '' : 's'}, plus the index) is rewritten in
            the same commit.
          </p>
          {props.dirty && (
            <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm">
              Your unsaved edits are not part of the move. Save them first, or
              they stay as a draft for the old path.
            </p>
          )}
          <div className="mt-4 space-y-4">
            <div>
              <label className="label" htmlFor="move-to">
                New path
              </label>
              <div className="flex items-center gap-1 font-mono text-sm">
                <span className="text-ink-3">wiki/</span>
                <input
                  id="move-to"
                  className="field font-mono"
                  value={to}
                  onChange={(e) =>
                    setTo(e.target.value.toLowerCase().replace(/\s+/g, '-'))
                  }
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <span className="text-ink-3">.md</span>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="move-message">
                Commit message
              </label>
              <input
                id="move-message"
                className="field font-mono text-sm"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            {error && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="btn ghost">Cancel</Dialog.Close>
            <button
              className="btn primary"
              onClick={move}
              disabled={busy || to === props.page.key || !to}
            >
              {busy ? 'Moving…' : 'Move page'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The page changed upstream. Shows the owner's edit (pre-merged with the
 * upstream changes when git could do so) as a diff against the upstream
 * version, with per-chunk accept/reject controls.
 */
function MergeDialog({
  conflict,
  onCancel,
  onResolve,
}: {
  conflict: { details: ConflictDetails; mine: string }
  onCancel: () => void
  onResolve: (text: string, blob: string) => void
}) {
  const { details, mine } = conflict
  const upstream = details.text
  const [doc, setDoc] = useState(details.merged ?? mine)
  const markers = /^(<{7}|={7}|>{7})( |$)/m.test(doc)
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog wide flex flex-col overflow-hidden p-0"
          aria-describedby={undefined}
        >
          <div className="border-b border-line px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 font-serif text-lg font-semibold">
              <GitMerge size={18} className="text-accent" /> Someone else
              changed this page
            </Dialog.Title>
            {upstream === null ? (
              <p className="mt-1 text-sm text-ink-2">
                It was moved or deleted upstream. Your text is kept as a draft;
                copy it somewhere safe or create it as a new page.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">
                {details.merged && !details.mergedConflicts
                  ? 'Your edit and the upstream changes touch different lines, so they were combined. '
                  : details.mergedConflicts
                    ? 'Both versions changed the same lines. Resolve the conflict markers below. '
                    : ''}
                Highlights show how the text below differs from the upstream
                version: accept or reject each chunk, edit freely, then save.
              </p>
            )}
          </div>
          {upstream !== null && (
            <div className="min-h-[40vh] flex-1 overflow-y-auto">
              <CodeEditor
                value={doc}
                onChange={setDoc}
                original={upstream}
                label="Merged page source"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            {markers && (
              <p className="mr-auto text-sm text-danger">
                Conflict markers remain.
              </p>
            )}
            <button className="btn ghost" onClick={onCancel}>
              Back to my edit
            </button>
            {upstream !== null && (
              <>
                <button
                  className="btn"
                  onClick={() => onResolve(upstream, details.blob!)}
                >
                  Take upstream
                </button>
                <button
                  className="btn primary"
                  disabled={markers}
                  onClick={() => onResolve(doc, details.blob!)}
                >
                  Use this version
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
