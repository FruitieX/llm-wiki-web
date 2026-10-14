export type Front = {
  type?: string | null
  status?: string | null
  updated?: string | null
  extra?: Record<string, string>
}

export type PageSummary = {
  key: string
  path: string
  blob: string
  title: string
  summary: string
  front: Front | null
  backlinks: number
}

export type RawFile = { path: string; blob: string; size: number }
export type Template = { name: string; text: string }

export type SaveState = {
  id: number
  paths: string[]
  state: 'pushing' | 'pushed' | 'failed'
  subject: string
  error: string | null
}

export type SyncStatus = {
  head: string
  branch: string
  lastSync: number | null
  lastError: string | null
  saves: SaveState[]
}

export type Wiki = {
  head: string
  pages: PageSummary[]
  raw: RawFile[]
  templates: Template[]
  sections: string[]
  status: SyncStatus
}

export type PageRef = { key: string; title: string; front: Front | null }

export type PageDetail = {
  key: string
  path: string
  blob: string
  title: string
  front: Front | null
  text: string
  backlinks: PageRef[]
  brokenLinks: string[]
  missingRaw: string[]
  head: string
}

export type RawDetail = {
  path: string
  size: number
  blob: string
  text: string | null
  citedBy: PageRef[]
}

export type SearchHit = {
  kind: 'page' | 'raw'
  key: string
  title: string
  snippet: string
  score: number
  front: Front | null
}

export type FileChange = {
  status: string
  path: string
  previousPath: string | null
}
export type Commit = {
  hash: string
  author: string
  date: string
  subject: string
  files: FileChange[]
}

export type CheckDelta = {
  errors: string[]
  warnings: string[]
  existingErrors: string[]
}

export type Committed = {
  head: string
  commit: string | null
  warnings: string[]
  save: number | null
  blobs: Record<string, string>
}

export type ConflictDetails = {
  path: string
  blob: string | null
  text: string | null
  merged: string | null
  mergedConflicts: boolean
}

export class ApiError extends Error {
  status: number
  details: any
  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.details = details
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      signal: init.signal,
      headers: {
        'x-llm-wiki': '1',
        ...(init.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new ApiError(0, 'The wiki server could not be reached.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/'))
      onUnauthorized?.()
    throw new ApiError(
      response.status,
      data?.message ?? `Request failed (${response.status}).`,
      data?.details,
    )
  }
  return data as T
}

export const q = encodeURIComponent
