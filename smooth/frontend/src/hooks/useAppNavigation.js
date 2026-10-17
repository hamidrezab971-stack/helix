import { useLayoutEffect, useState } from 'react'
import { createNavigationController, initialNavigation } from '../utils/navigation.js'

export default function useAppNavigation() {
  const [controller] = useState(() => createNavigationController(history, crypto.randomUUID()))
  const [route, setRoute] = useState(initialNavigation)
  useLayoutEffect(() => {
    controller.start(setRoute)
    window.addEventListener('popstate', controller.pop)
    return () => { window.removeEventListener('popstate', controller.pop); controller.stop() }
  }, [controller])
  return { route, navigate: controller.navigate, back: controller.back, tab: controller.tab }
}
