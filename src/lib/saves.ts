import { useSyncExternalStore } from 'react'

/**
 * Saves the server has committed locally but may still be pushing. The editor
 * keeps its draft (under `draftKey`) until the push is confirmed, so a failed
 * push never loses the edit.
 */
export type TrackedSave = {
  id: number
  key: string
  title: string
  /** The editor's draft slot: a page key, or `new` for an unsaved page. */
  draftKey: string | null
  state: 'pushing' | 'pushed' | 'failed'
  subject?: string
  error?: string | null
  warnings: string[]
  at: number
}

const STORAGE = 'llm-wiki-saves'
let saves: TrackedSave[] = load()
const listeners = new Set<() => void>()

function load(): TrackedSave[] {
  try {
    const list = JSON.parse(
      localStorage.getItem(STORAGE) ?? '[]',
    ) as TrackedSave[]
    // Forget anything settled or older than a day.
    return list.filter(
      (s) => s.state !== 'pushed' && Date.now() - s.at < 86_400_000,
    )
  } catch {
    return []
  }
}

function emit() {
  try {
    localStorage.setItem(
      STORAGE,
      JSON.stringify(saves.filter((s) => s.state !== 'pushed')),
    )
  } catch {}
  for (const listener of listeners) listener()
}

export function trackSave(save: Omit<TrackedSave, 'state' | 'at'>) {
  saves = [
    ...saves.filter((s) => s.id !== save.id),
    { ...save, state: 'pushing', at: Date.now() },
  ]
  emit()
}

export function updateSave(id: number, patch: Partial<TrackedSave>) {
  saves = saves.map((s) => (s.id === id ? { ...s, ...patch } : s))
  emit()
}

export function dismissSave(id: number) {
  saves = saves.filter((s) => s.id !== id)
  emit()
}

export function useSaves() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => saves,
  )
}

export function draftKey(key: string) {
  return `llm-wiki-draft:${key}`
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(draftKey(key))
  } catch {}
}
