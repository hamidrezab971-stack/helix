import { useEffect, useState } from 'react'
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query), update = () => setMatches(media.matches)
    media.addEventListener('change', update); update()
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}
