// Matchup Calculator — /portal/matchup-calculator.
//
// Built by interns Kai Malloch & Oliver Duthie as a self-contained
// HTML tool (Log5 outcome model + Bayesian-shrunk splits over an
// embedded 2026 data snapshot). It ships VERBATIM at
// public/tools/matchup-calculator.html — only its CSS was re-themed
// to the portal identity — and renders here in an iframe so the
// portal provides the gate, header, and page chrome. The tool follows
// the site dark-mode toggle via a ?theme= query param.
//
// To update the tool's data or logic, replace the HTML file with the
// interns' next export and re-apply the portal theme (the CSS block
// at the top of the file; everything below <body> is theirs).

import { useEffect, useState } from 'react'
import InternCredit from '../../components/InternCredit'

function useSiteDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

export default function MatchupCalculator() {
  const dark = useSiteDarkMode()

  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-5">
      <div className="mb-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Matchup Calculator</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
          Grade any batter vs pitcher matchup in the region on a 1-10 scale, with a Log5
          outcome tree, projected line, hand splits, and head-to-head history. Rank your
          whole roster against an opposing arm with the Best Matchup Finder.
        </p>
        <InternCredit names="Kai Malloch & Oliver Duthie" className="mt-1" />
      </div>

      {/* key forces a reload when the theme flips so the tool re-reads ?theme= */}
      <iframe
        key={dark ? 'dark' : 'light'}
        src={`/tools/matchup-calculator.html${dark ? '?theme=dark' : ''}`}
        title="Matchup Calculator"
        className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-portal-cream dark:bg-gray-900"
        style={{ height: 'calc(100vh - 210px)', minHeight: 640 }}
      />
    </div>
  )
}
