// HELIX outline family: 24px grid, 1.75px strokes, round joins and caps.
// Original SVG geometry, bundled locally; no font, CDN or runtime dependency.
const paths = {
  compose: <><path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6" /><path d="m14.5 4.5 5 5M11 18l-5 1 1-5L17 4a2.8 2.8 0 0 1 4 4Z" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5.3a3 3 0 0 1 0 5.4M18 14a5 5 0 0 1 3 4.6V20" /></>,
  person: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20v-1a7.5 7.5 0 0 1 15 0v1" /></>,
  settings: <><path d="m9.5 3-.6 2.3-2 .9-2.2-.6-2 3.4 1.6 1.8v2.4l-1.6 1.8 2 3.4 2.2-.6 2 .9.6 2.3h5l.6-2.3 2-.9 2.2.6 2-3.4-1.6-1.8v-2.4L21.3 9l-2-3.4-2.2.6-2-.9-.6-2.3Z" /><circle cx="12" cy="12" r="3.2" /></>,
  back: <path d="m11 5-7 7 7 7M4 12h16" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1.5" /><path d="m3.5 17 4.8-4.8a1 1 0 0 1 1.4 0l3.8 3.8 2.3-2.3a1 1 0 0 1 1.4 0l3.3 3.3" /></>,
  send: <><path d="m3.5 10.5 16-7a.8.8 0 0 1 1 1l-7 16a.7.7 0 0 1-1.3 0L10 14l-6.5-2.2a.7.7 0 0 1 0-1.3Z" /><path d="m10 14 6-6" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  checks: <path d="m2.5 12 4 4L16 6.5M11 14l2.5 2.5L22 8" />,
  reply: <path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7v1" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="3" /><path d="M15 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2" /></>,
  edit: <><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15Z" /></>,
  trash: <><path d="M4 6h16M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 6l.8 13a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2L18 6M10 10v6M14 10v6" /></>,
  logout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M11 12h10m-4-4 4 4-4 4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20 14.2A8 8 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" />,
  chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 1 .9-5A8.5 8.5 0 1 1 21 11.5Z" /><path d="M8 9.5h8M8 13.5h5" /></>,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  up: <path d="M12 20V4m-6 6 6-6 6 6" />,
  left: <path d="M20 12H4m6-6-6 6 6 6" />,
  right: <path d="M4 12h16m-6-6 6 6-6 6" />,
  more: <g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></g>,
  retry: <><path d="M20 8V3m0 5h-5M20 8a8 8 0 1 0 .6 6" /></>,
  camera: <><path d="m8 5 1.2-2h5.6L16 5h2a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" /><circle cx="12" cy="12.5" r="4" /></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4v.01" /></>,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14a4.5 4.5 0 0 0 8 0M8 9h.01M16 9h.01" /></>,
}
export const iconNames = Object.freeze(Object.keys(paths))

export default function Icon({ name, size = 20, className = '' }) {
  return <svg aria-hidden="true" focusable="false" data-icon={name} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`helix-icon ${className}`.trim()}>{paths[name]}</svg>
}

export function HelixMark({ className = '' }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 32 32" fill="none" className={`helix-mark ${className}`.trim()}><path d="M9 5c0 8 14 14 14 22M23 5c0 8-14 14-14 22M10 8h12M12 12h8M12 20h8M10 24h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}
