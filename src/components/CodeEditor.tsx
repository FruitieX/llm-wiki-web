import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { getChunks, unifiedMergeView } from '@codemirror/merge'
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { rankKeys } from '../lib/wiki'

const highlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontWeight: '700',
    fontSize: '1.15em',
    color: 'var(--ink)',
  },
  {
    tag: t.heading2,
    fontWeight: '700',
    fontSize: '1.08em',
    color: 'var(--ink)',
  },
  {
    tag: [t.heading3, t.heading4, t.heading5, t.heading6],
    fontWeight: '700',
    color: 'var(--ink)',
  },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--t-analysis)' },
  {
    tag: [t.processingInstruction, t.meta, t.contentSeparator],
    color: 'var(--ink-3)',
  },
  { tag: t.quote, color: 'var(--ink-2)', fontStyle: 'italic' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-content': {
    padding: '1.25rem 0 40vh',
    caretColor: 'var(--accent)',
    maxWidth: '46rem',
    margin: '0 auto',
  },
  '.cm-line': { padding: '0 1.25rem' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor:
        'color-mix(in srgb, var(--accent) 24%, transparent) !important',
    },
  '.cm-selectionMatch': { backgroundColor: 'var(--mark)' },
  '.cm-placeholder': { color: 'var(--ink-3)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elev)',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-sans)',
    maxHeight: '16rem',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '0.35rem 0.7rem !important',
    lineHeight: '1.3',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--ink)',
  },
  '.cm-completionLabel': { fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  '.cm-completionDetail': {
    color: 'var(--ink-3)',
    fontStyle: 'normal',
    marginLeft: '0.75em',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--accent)',
    fontWeight: '600',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--ink)',
    borderColor: 'var(--line)',
  },
  '.cm-panel.cm-search': {
    padding: '0.5rem 0.75rem',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    borderRadius: '6px',
    border: '1px solid var(--line-strong)',
    background: 'var(--bg)',
    color: 'var(--ink)',
    backgroundImage: 'none',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)' },
  '.cm-changedLine': { backgroundColor: 'var(--diff-add) !important' },
  '.cm-changedText': { background: 'var(--diff-add-strong) !important' },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diff-del) !important',
    paddingLeft: '1.25rem',
  },
  '.cm-deletedChunk del': {
    textDecoration: 'none',
    background: 'var(--diff-del-strong)',
  },
  '.cm-chunkButtons button': {
    fontFamily: 'var(--font-sans)',
    fontSize: '0.75rem',
    borderRadius: '6px',
    border: '1px solid var(--line-strong)',
    padding: '0.1rem 0.5rem',
    margin: '0.2rem 0.25rem 0.2rem 0',
    background: 'var(--bg-elev)',
    color: 'var(--ink)',
  },
  '.cm-chunkButtons button[name=accept]': {
    background: 'var(--accent)',
    color: 'var(--accent-ink)',
    borderColor: 'var(--accent)',
  },
})

export type Completions = {
  pages: { key: string; title: string }[]
  raw: string[]
}

function wikiCompletion(source: () => Completions) {
  return (context: CompletionContext) => {
    const link = context.matchBefore(/\[\[[^\][|#\n]*/)
    if (link) {
      const after = context.state.sliceDoc(context.pos, context.pos + 2)
      return {
        from: link.from + 2,
        filter: false,
        options: rankKeys(source().pages, link.text.slice(2))
          .slice(0, 60)
          .map((page) => ({
            label: page.key,
            detail: page.title,
            apply: after === ']]' ? page.key : `${page.key}]]`,
          })),
      }
    }
    const raw = context.matchBefore(/`raw\/[^`\s]*/)
    if (raw) {
      const needle = raw.text.slice(1).toLowerCase()
      const after = context.state.sliceDoc(context.pos, context.pos + 1)
      return {
        from: raw.from + 1,
        filter: false,
        options: source()
          .raw.filter((path) => path.toLowerCase().includes(needle))
          .slice(0, 60)
          .map((path) => ({
            label: path,
            apply: after === '`' ? path : `${path}\``,
          })),
      }
    }
    return null
  }
}

export type CodeEditorHandle = { focus(): void; getValue(): string }

export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    value: string
    onChange?: (value: string) => void
    onSave?: () => void
    completions?: () => Completions
    /** When set, shows a unified diff against this text with accept/reject controls. */
    original?: string
    autoFocus?: boolean
    label?: string
  }
>(function CodeEditor(
  {
    value,
    onChange,
    onSave,
    completions,
    original,
    autoFocus,
    label = 'Page source',
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave, completions })
  callbacks.current = { onChange, onSave, completions }

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    getValue: () => view.current?.state.doc.toString() ?? '',
  }))

  useEffect(() => {
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(highlight),
      search({ top: true }),
      highlightSelectionMatches(),
      placeholder('Write in Markdown. Type [[ to link a page.'),
      autocompletion({
        override: [
          wikiCompletion(
            () => callbacks.current.completions?.() ?? { pages: [], raw: [] },
          ),
        ],
        icons: false,
      }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            callbacks.current.onSave?.()
            return true
          },
        },
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged)
          callbacks.current.onChange?.(update.state.doc.toString())
      }),
      EditorView.contentAttributes.of({
        'aria-label': label,
        spellcheck: 'true',
        autocapitalize: 'sentences',
      }),
      theme,
    ]
    if (original !== undefined)
      extensions.push(
        unifiedMergeView({ original, mergeControls: true, gutter: false }),
      )
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions }),
    })
    if (autoFocus) view.current.focus()
    if (original !== undefined) {
      // Bring the first difference into view once the merge view has computed it.
      const current = view.current
      requestAnimationFrame(() => {
        const first = getChunks(current.state)?.chunks[0]
        if (first)
          current.dispatch({
            effects: EditorView.scrollIntoView(first.fromB, { y: 'center' }),
          })
      })
    }
    return () => view.current?.destroy()
    // The editor owns its document after mount; `value` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original])

  // Replace the document when the caller swaps in a different text (e.g. a merge result).
  useEffect(() => {
    const current = view.current
    if (current && current.state.doc.toString() !== value) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      })
    }
  }, [value])

  return <div ref={host} className="h-full min-h-0" />
})
