import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { api, ApiError, type Committed, type PageDetail } from './api'
import { trackSave, updateSave } from './saves'
import { areaFor } from './wiki'

/** Flips the `[ ]` / `[x]` of the task-list item that starts at `offset`. */
export function toggleTask(text: string, offset: number) {
  const end = text.indexOf('\n', offset)
  const line = text.slice(offset, end < 0 ? undefined : end)
  const match = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]\s*(.*)$/)
  if (!match) return null
  const at = offset + match[1].length
  const checked = match[2] === ' '
  return {
    text: text.slice(0, at) + (checked ? 'x' : ' ') + text.slice(at + 1),
    checked,
    item: match[3]
      .replace(
        /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
        (_, k, l) => l ?? k,
      )
      .replace(/[*_`]/g, ''),
  }
}

/**
 * Ticking a checkbox on a page saves at once with its own commit subject.
 * Toggles are applied optimistically and sent one after another, each on top
 * of the blob the previous save produced.
 */
export function useTaskToggle(page: PageDetail | undefined) {
  const client = useQueryClient()
  const chain = useRef<Promise<void>>(Promise.resolve())
  const current = useRef<{ key: string; text: string; blob: string } | null>(
    null,
  )
  const pending = useRef(0)

  useEffect(() => {
    if (page && pending.current === 0)
      current.current = { key: page.key, text: page.text, blob: page.blob }
  }, [page])

  return useCallback(
    (bodyOffset: number, offset: number) => {
      const state = current.current
      if (!state || !page) return
      const toggled = toggleTask(state.text, bodyOffset + offset)
      if (!toggled) return
      state.text = toggled.text
      // A refetch already in flight would bring back the old text.
      void client.cancelQueries({ queryKey: ['page', state.key] })
      client.setQueryData<PageDetail>(['page', state.key], (old) =>
        old ? { ...old, text: toggled.text } : old,
      )
      const item =
        toggled.item.length > 50
          ? `${toggled.item.slice(0, 49)}…`
          : toggled.item
      const message = `docs(${areaFor(state.key)}): ${toggled.checked ? 'check' : 'uncheck'} "${item}"`
      pending.current += 1
      chain.current = chain.current.then(async () => {
        try {
          const result = await api<Committed>('/api/page', {
            method: 'PUT',
            body: {
              key: state.key,
              text: state.text,
              baseBlob: state.blob,
              message,
            },
          })
          state.blob = result.blobs[`wiki/${state.key}.md`] ?? state.blob
          const confirmed = { text: state.text, blob: state.blob }
          client.setQueryData<PageDetail>(['page', state.key], (old) =>
            old ? { ...old, ...confirmed } : old,
          )
          if (result.save !== null)
            trackSave({
              id: result.save,
              key: state.key,
              title: page.title,
              draftKey: null,
              warnings: [],
            })
        } catch (error) {
          const id = -Date.now()
          trackSave({
            id,
            key: state.key,
            title: page.title,
            draftKey: null,
            warnings: [],
          })
          updateSave(id, {
            state: 'failed',
            error:
              error instanceof ApiError && error.status === 409
                ? 'The page changed upstream, so the checkbox was not saved. It has been reloaded.'
                : error instanceof ApiError
                  ? error.message
                  : 'The checkbox could not be saved.',
          })
          pending.current = 0
          await client.invalidateQueries({ queryKey: ['page', state.key] })
        } finally {
          pending.current = Math.max(0, pending.current - 1)
        }
      })
    },
    [client, page],
  )
}
