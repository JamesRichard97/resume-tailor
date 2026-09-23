/** The app mark — same artwork as public/favicon.svg, inlined so it picks up
 *  crisp rendering at small sizes without an extra request. */
export default function Logo({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Resume Tailor"
    >
      <defs>
        <linearGradient id="rt-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4b7bf5" />
          <stop offset="1" stopColor="#2540c4" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="8" fill="url(#rt-mark)" />

      <path
        d="M9 7.5h9.2L24 13.2v11.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 8 24.5v-15.5A1.5 1.5 0 0 1 9.5 7.5Z"
        fill="#ffffff"
      />
      <path d="M18 7.5 24 13.2h-4.6A1.4 1.4 0 0 1 18 11.8Z" fill="#c9d8fd" />

      <rect x="11" y="15" width="10" height="1.8" rx="0.9" fill="#93aef7" />
      <rect x="11" y="18.4" width="7" height="1.8" rx="0.9" fill="#2540c4" />
      <rect x="11" y="21.8" width="9" height="1.8" rx="0.9" fill="#93aef7" />
    </svg>
  )
}
