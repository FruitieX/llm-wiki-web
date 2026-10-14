import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import {
  ChevronRight,
  CloudOff,
  FilePlus2,
  Home as HomeIcon,
  KeyRound,
  Library,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Search as SearchIcon,
  Sun,
} from 'lucide-react'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { api, ApiError, type PageSummary, type SyncStatus } from '../lib/api'
import { useSyncWatcher, useWiki } from '../lib/queries'
import { useTheme } from '../lib/theme'
import { FOLDERS, folderOf, relativeTime } from '../lib/wiki'
import { Mark } from './Mark'
import { SearchDialog } from './Search'
import { PasswordDialog } from './Password'
import { Loading } from './States'

export function Shell() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  useSyncWatcher(true)

  useEffect(() => setDrawerOpen(false), [location.pathname])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing =
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if (
        (event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !typing)
      ) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const editing =
    location.pathname.startsWith('/edit/') || location.pathname === '/new'

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <aside className="fixed inset-y-0 left-0 hidden w-72 flex-col border-r border-line lg:flex">
        <Sidebar onSearch={() => setSearchOpen(true)} />
      </aside>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay lg:hidden" />
          <Dialog.Content
            className="drawer lg:hidden"
            aria-describedby={undefined}
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Sidebar
              onSearch={() => {
                setDrawerOpen(false)
                setSearchOpen(true)
              }}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="lg:pl-72">
        {!editing && (
          <header
            className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-line bg-bg/90 px-2 backdrop-blur lg:hidden"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <button
              className="icon-btn"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
            >
              <MenuIcon size={20} />
            </button>
            <Link to="/" className="flex items-center gap-2 px-1">
              <Mark size={24} />
              <span className="font-serif text-[1.05rem] font-semibold tracking-tight">
                llm-wiki
              </span>
            </Link>
            <div className="flex-1" />
            <button
              className="icon-btn"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
            >
              <SearchIcon size={20} />
            </button>
            <MoreMenu />
          </header>
        )}
        <main>
          <Suspense
            fallback={
              <div className="mx-auto max-w-3xl px-5 py-10">
                <Loading />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}

const OPEN_KEY = 'llm-wiki-open-folders'
function useOpenFolders() {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}')
    } catch {
      return {}
    }
  })
  const toggle = (folder: string, value: boolean) => {
    const next = { ...open, [folder]: value }
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next))
    } catch {}
  }
  return [open, toggle] as const
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const wiki = useWiki()
  const location = useLocation()
  const [open, toggle] = useOpenFolders()
  const current = decodeURIComponent(
    location.pathname.replace(/^\/(page|edit|history)\//, ''),
  )

  const groups = useMemo(() => {
    const byFolder = new Map<string, PageSummary[]>()
    for (const page of wiki.data?.pages ?? []) {
      const folder = folderOf(page.key)
      if (!byFolder.has(folder)) byFolder.set(folder, [])
      byFolder.get(folder)!.push(page)
    }
    for (const list of byFolder.values())
      list.sort((a, b) => a.title.localeCompare(b.title))
    const known = Object.keys(FOLDERS)
    const extra = [...byFolder.keys()]
      .filter((f) => f && !known.includes(f))
      .sort()
    return [...known, ...extra]
      .filter((folder) => byFolder.has(folder))
      .map((folder) => ({
        folder,
        label: FOLDERS[folder] ?? folder,
        pages: byFolder.get(folder)!,
      }))
  }, [wiki.data])
  const topLevel = useMemo(
    () => (wiki.data?.pages ?? []).filter((page) => !folderOf(page.key)),
    [wiki.data],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <Link to="/" className="flex items-center gap-2.5">
          <Mark size={28} />
          <span className="font-serif text-lg font-semibold tracking-tight">
            llm-wiki
          </span>
        </Link>
      </div>
      <div className="px-3 pb-2">
        <button
          onClick={onSearch}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-elev px-3 text-sm text-ink-3 transition hover:border-line-strong"
        >
          <SearchIcon size={15} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="hidden rounded border border-line px-1.5 font-sans text-[0.7rem] lg:inline">
            /
          </kbd>
        </button>
      </div>
      <nav className="scroll-thin flex-1 overflow-y-auto px-3 pb-4 text-[0.9rem]">
        <NavItem
          to="/"
          icon={<HomeIcon size={16} />}
          label="Home"
          active={location.pathname === '/'}
        />
        <NavItem
          to="/pages"
          icon={<Library size={16} />}
          label="All pages"
          active={location.pathname === '/pages'}
        />
        <NavItem
          to="/new"
          icon={<FilePlus2 size={16} />}
          label="New page"
          active={location.pathname === '/new'}
        />
        <div className="mt-4 space-y-0.5">
          {topLevel.map((page) => (
            <PageItem
              key={page.key}
              page={page}
              active={current === page.key}
            />
          ))}
        </div>
        {groups.map(({ folder, label, pages }) => {
          const isOpen =
            open[folder] ?? pages.some((page) => page.key === current)
          return (
            <div key={folder} className="mt-3">
              <button
                onClick={() => toggle(folder, !isOpen)}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink-2"
                aria-expanded={isOpen}
              >
                <ChevronRight
                  size={13}
                  className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
                {label}
                <span className="ml-auto font-medium tracking-normal">
                  {pages.length}
                </span>
              </button>
              {isOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {pages.map((page) => (
                    <PageItem
                      key={page.key}
                      page={page}
                      active={current === page.key}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!!wiki.data?.raw.length && (
          <RawGroup
            open={open['raw'] ?? location.pathname.startsWith('/raw/')}
            onToggle={(value) => toggle('raw', value)}
            files={wiki.data.raw.map((file) => file.path)}
            current={decodeURIComponent(
              location.pathname.replace(/^\/raw\//, ''),
            )}
          />
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-1 border-t border-line px-3 py-2">
        <SyncIndicator />
        <MoreMenu />
      </div>
    </div>
  )
}

function NavItem({
  to,
  icon,
  label,
  active,
}: {
  to: '/' | '/pages' | '/new'
  icon: React.ReactNode
  label: string
  active: boolean
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition ${
        active
          ? 'bg-accent-soft font-medium text-ink'
          : 'text-ink-2 hover:bg-hover hover:text-ink'
      }`}
    >
      <span className={active ? 'text-accent' : 'text-ink-3'}>{icon}</span>
      {label}
    </Link>
  )
}

function PageItem({ page, active }: { page: PageSummary; active: boolean }) {
  return (
    <Link
      to="/page/$"
      params={{ _splat: page.key }}
      className={`block truncate rounded-lg px-2.5 py-1.5 transition ${
        active
          ? 'bg-accent-soft font-medium text-ink'
          : 'text-ink-2 hover:bg-hover hover:text-ink'
      }`}
      title={page.key}
    >
      {page.title}
    </Link>
  )
}

function RawGroup({
  open,
  onToggle,
  files,
  current,
}: {
  open: boolean
  onToggle: (value: boolean) => void
  files: string[]
  current: string
}) {
  return (
    <div className="mt-3">
      <button
        onClick={() => onToggle(!open)}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink-2"
        aria-expanded={open}
      >
        <ChevronRight
          size={13}
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
        Raw evidence
        <span className="ml-auto font-medium tracking-normal">
          {files.length}
        </span>
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {files.map((path) => (
            <Link
              key={path}
              to="/raw/$"
              params={{ _splat: path }}
              className={`block truncate rounded-lg px-2.5 py-1.5 font-mono text-[0.78rem] transition ${
                current === path
                  ? 'bg-accent-soft text-ink'
                  : 'text-ink-2 hover:bg-hover hover:text-ink'
              }`}
              title={path}
            >
              {path.replace(/^raw\//, '')}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function SyncIndicator() {
  const client = useQueryClient()
  const status = client.getQueryData<SyncStatus>(['status'])
  const wiki = useWiki()
  const data = status ?? wiki.data?.status
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])
  async function syncNow() {
    setBusy(true)
    try {
      const next = await api<SyncStatus>('/api/sync', { method: 'POST' })
      client.setQueryData(['status'], next)
    } catch (error) {
      if (error instanceof ApiError)
        client.invalidateQueries({ queryKey: ['status'] })
    } finally {
      setBusy(false)
    }
  }
  const failing = !!data?.lastError
  return (
    <button
      onClick={syncNow}
      disabled={busy}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-3 hover:bg-hover"
      title={
        data?.lastError ??
        `Branch ${data?.branch ?? ''} at ${data?.head.slice(0, 8) ?? ''}. Click to sync now.`
      }
    >
      {failing ? (
        <CloudOff size={14} className="shrink-0 text-warn" />
      ) : (
        <RefreshCw
          size={14}
          className={`shrink-0 ${busy ? 'animate-spin' : ''}`}
        />
      )}
      <span className="truncate">
        {failing
          ? 'GitHub unreachable'
          : data?.lastSync
            ? `Synced ${relativeTime(data.lastSync * 1000)}`
            : 'Syncing…'}
      </span>
    </button>
  )
}

function MoreMenu() {
  const [theme, setTheme] = useTheme()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [passwordOpen, setPasswordOpen] = useState(false)
  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    client.clear()
    await navigate({ to: '/' })
    client.invalidateQueries({ queryKey: ['auth'] })
  }
  const next =
    theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const ThemeIcon =
    theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="icon-btn shrink-0" aria-label="More">
          <MoreHorizontal size={18} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu" align="end" sideOffset={6}>
            <Menu.Item
              className="menu-item"
              onSelect={(event) => {
                event.preventDefault()
                setTheme(next)
              }}
            >
              <ThemeIcon size={16} />
              Theme: {theme === 'system' ? 'match system' : theme}
            </Menu.Item>
            <Menu.Item
              className="menu-item"
              onSelect={() => setPasswordOpen(true)}
            >
              <KeyRound size={16} />
              Change password
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className="menu-item" onSelect={signOut}>
              <LogOut size={16} />
              Sign out
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </>
  )
}
