// Lazy wrapper around WpaByGameChart.
//
// WpaByGameChart pulls in recharts (~114 kB gzip). The player profile pages are
// the hottest deep pages on the site, and this chart sits well below the fold,
// so we defer loading recharts until the chart actually renders. Drop-in
// replacement: profile pages import this instead of WpaByGameChart directly, so
// recharts no longer rides along in the initial bundle for every player view.

import { lazy, Suspense } from 'react'

const WpaByGameChart = lazy(() => import('./WpaByGameChart'))

export default function LazyWpaByGameChart(props) {
  return (
    <Suspense fallback={<div className="text-[12px] text-center py-10 text-gray-400">Loading chart…</div>}>
      <WpaByGameChart {...props} />
    </Suspense>
  )
}
