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
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SyncStatus>('/api/status'),
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    enabled,
  })
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
