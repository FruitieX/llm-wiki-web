/** The app mark: an open book with a small sun, in the accent colour. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <path
        d="M18 17h9.5c2.5 0 4.5 1.4 4.5 4v26c0-2.2-1.8-3.6-4.2-3.6H18z"
        fill="var(--bg)"
      />
      <path
        d="M46 17h-9.5c-2.5 0-4.5 1.4-4.5 4v26c0-2.2 1.8-3.6 4.2-3.6H46z"
        fill="var(--bg)"
        opacity="0.82"
      />
      <circle cx="46" cy="44" r="5.5" fill="#f3c969" />
    </svg>
  )
}
