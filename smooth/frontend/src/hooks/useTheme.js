import { useLayoutEffect, useState } from 'react'

export default function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('helix_theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' }
  })
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111719' : '#f5f7f6')
    try { localStorage.setItem('helix_theme', theme) } catch { /* Theme still works when storage is unavailable. */ }
  }, [theme])
  return [theme, () => setTheme(current => current === 'dark' ? 'light' : 'dark')]
}
