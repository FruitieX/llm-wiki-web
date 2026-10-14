import * as Dialog from '@radix-ui/react-dialog'
import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'

export function PasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { current, password },
      })
      setDone(true)
      setCurrent('')
      setPassword('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) {
          setDone(false)
          setError(null)
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog p-5" aria-describedby={undefined}>
          <Dialog.Title className="font-serif text-lg font-semibold">
            Change password
          </Dialog.Title>
          {done ? (
            <>
              <p className="mt-3 text-ink-2">
                Password changed. Other devices are signed out.
              </p>
              <div className="mt-5 flex justify-end">
                <Dialog.Close className="btn primary">Done</Dialog.Close>
              </div>
            </>
          ) : (
            <form onSubmit={submit} className="mt-4 space-y-4">
              <div>
                <label className="label" htmlFor="current-password">
                  Current password
                </label>
                <input
                  id="current-password"
                  type="password"
                  className="field"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="new-password">
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  className="field"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </div>
              {error && (
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close type="button" className="btn ghost">
                  Cancel
                </Dialog.Close>
                <button className="btn primary" disabled={busy}>
                  Change password
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
