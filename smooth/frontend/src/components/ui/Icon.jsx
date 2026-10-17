const paths = {
  compose: <><path d="M13 5H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7" /><path d="m14 4 4 4M10 16l4-1 7-7a2.8 2.8 0 0 0-4-4l-7 7-1 5Z" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-3-5" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  settings: <><path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 3 3-1 2 3 4-1 1-3 3-1 1-4-3-2V7l-3-3-3 1-2-2Z" /><circle cx="12" cy="12" r="3" /></>,
  back: <path d="m14 6-6 6 6 6M8 12h12" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="8" cy="8" r="1" /><path d="m4 17 5-5 4 4 3-3 5 5" /></>,
  send: <><path d="m5 12 14-7-5 15-3-6-6-2Z" /><path d="m11 14 8-9" /></>,
  close: <path d="m7 7 10 10M17 7 7 17" />,
  check: <path d="m5 12 4 4L19 6" />,
  reply: <path d="m9 6-6 6 6 6M3 12h11a6 6 0 0 1 6 6" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="3" /><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>,
  edit: <><path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14l-1 6Z" /></>,
  trash: <><path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6M14 10v6" /></>,
  logout: <><path d="M10 4H5v16h5M10 12h11m-4-4 4 4-4 4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20 14a8 8 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z" />,
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5a9 9 0 0 1 18 0ZM8 10h8m-8 4h5" />,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
}

export default function Icon({ name, size = 20, className = '' }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>{paths[name]}</svg>
}

export function HelixMark({ className = '' }) {
  return <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className={className}><path d="M9 5c0 8 14 14 14 22M23 5c0 8-14 14-14 22M10 8h12M12 12h8M12 20h8M10 24h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
}
