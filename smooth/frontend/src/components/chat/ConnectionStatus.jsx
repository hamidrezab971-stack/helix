import { useEffect, useState } from 'react'

export default function ConnectionStatus({ state }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(false)
    if (state === 'connected') return
    const timer = setTimeout(() => setVisible(true), 1800)
    return () => clearTimeout(timer)
  }, [state])
  if (!visible || state === 'connected') return null
  return <p className="connection-status" role="status"><span className="loading-spinner" aria-hidden="true" />{state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</p>
}
