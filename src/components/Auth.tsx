import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, setUnauthorizedHandler } from '../lib/api'
import { KeyRound } from 'lucide-react'
import { Mark } from './Mark'

type AuthStatus = {
  configured: boolean
  signedIn: boolean
  setupAvailable: boolean
  oidc?: boolean
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthStatus>('/api/auth/status'),
    staleTime: 5 * 60_000,
  })
}

export function AuthGate({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const status = useAuthStatus()
  useEffect(() => {
    setUnauthorizedHandler(() =>
      client.invalidateQueries({ queryKey: ['auth'] }),
    )
  }, [client])
  if (status.isPending)
    return <div className="min-h-dvh bg-bg" aria-busy="true" />
  if (status.isError)
    return (
      <Frame>
        <p className="text-center text-ink-2">
          {status.error instanceof ApiError
            ? status.error.message
            : 'Something went wrong.'}
        </p>
        <button
          className="btn mx-auto mt-4 flex"
          onClick={() => status.refetch()}
        >
          Try again
        </button>
      </Frame>
    )
  if (!status.data.signedIn) return <SignIn status={status.data} />
  return <>{children}</>
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Mark size={44} />
          <h1 className="font-serif text-2xl font-semibold tracking-tight">
            llm-wiki
          </h1>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The callback sends failed passkey sign-ins back here with `?signin=failed`. */
function takeSignInFailure() {
  const url = new URL(window.location.href)
  if (url.searchParams.get('signin') !== 'failed') return false
  url.searchParams.delete('signin')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  return true
}

function SignIn({ status }: { status: AuthStatus }) {
  const [failed] = useState(takeSignInFailure)
  const [usePassword, setUsePassword] = useState(false)
  const fallback = status.configured || status.setupAvailable
  if (!status.oidc || usePassword)
    return (
      <PasswordSignIn
        status={status}
        onPasskey={status.oidc ? () => setUsePassword(false) : undefined}
      />
    )
  const next = window.location.pathname + window.location.search
  return (
    <Frame>
      <div className="space-y-4 rounded-2xl border border-line bg-elev p-5 shadow-soft">
        {failed && (
          <p
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
            role="alert"
          >
            Passkey sign-in didn't work. Try again, or check that your account
            may use the wiki.
          </p>
        )}
        <a
          className="btn primary h-11 w-full"
          href={`/auth/login?next=${encodeURIComponent(next)}`}
          data-oidc-login
        >
          <KeyRound size={16} />
          Sign in with passkey
        </a>
        <p className="text-center text-xs text-ink-3">Through Pocket ID.</p>
      </div>
      {fallback && (
        <button
          type="button"
          className="mx-auto mt-5 block text-sm text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          onClick={() => setUsePassword(true)}
        >
          {status.configured
            ? 'Use the owner password instead'
            : 'Set an owner password instead'}
        </button>
      )}
    </Frame>
  )
}

function PasswordSignIn({
  status,
  onPasskey,
}: {
  status: AuthStatus
  onPasskey?: () => void
}) {
  const client = useQueryClient()
  const setup = !status.configured
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (setup)
        await api('/api/auth/setup', {
          method: 'POST',
          body: { token, password },
        })
      else await api('/api/auth/login', { method: 'POST', body: { password } })
      await client.invalidateQueries()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  if (setup && !status.setupAvailable)
    return (
      <Frame>
        <p className="text-center text-ink-2">
          No password is set and this deployment has no setup token. Add
          <code className="mx-1 rounded bg-sunk px-1">
            LLM_WIKI_SETUP_TOKEN
          </code>
          to its secret.
        </p>
      </Frame>
    )

  return (
    <Frame>
      <form
        onSubmit={submit}
        className="space-y-4 rounded-2xl border border-line bg-elev p-5 shadow-soft"
      >
        {setup && (
          <>
            <p className="text-sm text-ink-2">
              First visit: enter the setup token from the deployment secret and
              choose a password.
            </p>
            <div>
              <label className="label" htmlFor="token">
                Setup token
              </label>
              <input
                id="token"
                className="field font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
          </>
        )}
        <div>
          <label className="label" htmlFor="password">
            {setup ? 'New password' : 'Password'}
          </label>
          <input
            id="password"
            type="password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setup ? 'new-password' : 'current-password'}
            minLength={setup ? 12 : undefined}
            autoFocus={!setup}
            required
          />
          {setup && (
            <p className="mt-1.5 text-xs text-ink-3">At least 12 characters.</p>
          )}
        </div>
        {error && (
          <p
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <button className="btn primary w-full" disabled={busy}>
          {busy ? 'One moment…' : setup ? 'Set password' : 'Sign in'}
        </button>
      </form>
      {onPasskey && (
        <button
          type="button"
          className="mx-auto mt-5 block text-sm text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          onClick={onPasskey}
        >
          Sign in with a passkey instead
        </button>
      )}
    </Frame>
  )
}
