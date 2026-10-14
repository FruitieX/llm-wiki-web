import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import {
  api,
  q,
  type Commit,
  type PageDetail,
  type RawDetail,
  type SyncStatus,
  type Wiki,
} from './api'
import { clearDraft, updateSave, useSaves } from './saves'

export function useWiki() {
  return useQuery({
    queryKey: ['wiki'],
    queryFn: () => api<Wiki>('/api/wiki'),
    staleTime: 30_000,
  })
}

export function usePageKeys() {
  const wiki = useWiki()
  return useMemo(
    () => new Set(wiki.data?.pages.map((page) => page.key) ?? []),
    [wiki.data],
  )
}

export function usePageTitles() {
  const wiki = useWiki()
  return useMemo(
    () => new Map(wiki.data?.pages.map((page) => [page.key, page.title]) ?? []),
    [wiki.data],
  )
}

export function usePage(key: string) {
  return useQuery({
    queryKey: ['page', key],
    queryFn: () => api<PageDetail>(`/api/page?key=${q(key)}`),
    enabled: !!key,
  })
}

export function useRaw(path: string) {
  return useQuery({
    queryKey: ['raw', path],
    queryFn: () => api<RawDetail>(`/api/raw?path=${q(path)}`),
  })
}

export function useRecent(limit = 30) {
  return useQuery({
    queryKey: ['recent', limit],
    queryFn: () => api<{ commits: Commit[] }>(`/api/recent?limit=${limit}`),
  })
}

export function useHistory(path: string | undefined) {
  return useQuery({
    queryKey: ['history', path],
    queryFn: () => api<{ commits: Commit[] }>(`/api/history?path=${q(path!)}`),
    enabled: !!path,
  })
}

/**
 * Polls the server's sync status and refreshes cached wiki data whenever the
 * clone moves to a new commit (an agent pushed, or another device saved).
 */
export function useSyncWatcher(enabled: boolean) {
  const client = useQueryClient()
  const saves = useSaves()
  const pushing = saves.some((save) => save.state === 'pushing')
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SyncStatus>('/api/status'),
    // Poll briefly and often while a save is on its way to GitHub.
    refetchInterval: pushing ? 1_200 : 20_000,
    refetchIntervalInBackground: pushing,
    enabled,
  })
  useEffect(() => {
    for (const save of saves) {
      if (save.state !== 'pushing') continue
      const server = status.data?.saves.find((s) => s.id === save.id)
      if (server && server.state !== 'pushing') {
        if (server.state === 'pushed' && save.draftKey)
          clearDraft(save.draftKey)
        updateSave(save.id, {
          state: server.state,
          subject: server.subject,
          error: server.error,
        })
        // A failed push is reset away on the server: show the old text again.
        if (server.state === 'failed') client.invalidateQueries()
      } else if (!server && status.data && Date.now() - save.at > 60_000) {
        // The server restarted and lost track; the draft is still here.
        updateSave(save.id, {
          state: 'failed',
          error:
            'The server restarted before confirming this save. Check the page and save again if needed.',
        })
      }
    }
  }, [status.data, saves, client])
  const head = useRef<string | null>(null)
  useEffect(() => {
    const next = status.data?.head
    if (!next) return
    if (head.current && head.current !== next) {
      for (const key of ['wiki', 'page', 'raw', 'recent', 'history'])
        client.invalidateQueries({ queryKey: [key] })
    }
    head.current = next
  }, [status.data?.head, client])
  return status
}
