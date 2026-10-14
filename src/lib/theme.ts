import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'llm-wiki-theme'

function read(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {}
  return 'system'
}

function apply(choice: ThemeChoice) {
  const dark =
    choice === 'dark' ||
    (choice === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#15171a' : '#f7f4ee')
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  useEffect(() => {
    apply(choice)
    try {
      if (choice === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, choice)
    } catch {}
    if (choice !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => apply('system')
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [choice])
  return [choice, setChoice] as const
}
