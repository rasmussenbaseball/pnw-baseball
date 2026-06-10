// "Statistically Similar Players" card for the player profile pages.
//
// Fetches /players/{id}/comps and shows the player's three closest recent-MLB
// player-seasons plus their single closest NW comparable, with a link to the
// full Player Comparison tool for the rest. Pass `side` so it matches whichever
// side the profile page is currently showing (matters for two-way players). The
// number on each comp is a 0-100 match score (higher = more similar), labeled
// MATCH so it reads in context.
//
// Powered by the comp model built by interns Trevor Kazahaya and Connor Broschard.

import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePlayerProfileTheme, pctColor } from './playerProfile/shared'
import { CURRENT_SEASON } from '../lib/seasons'

function ScorePill({ score }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full text-white text-[12px] font-extrabold shrink-0"
      style={{ background: pctColor(score), width: 34, height: 34 }}>
      {Math.round(score)}
    </span>
  )
}

function CompRow({ T, r, sub, to }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">
        {to ? (
          <Link to={to} className="text-[13px] font-semibold hover:underline truncate block" style={{ color: T.accent }}>
            {r.name}
          </Link>
        ) : (
          <div className="text-[13px] font-semibold truncate" style={{ color: T.text }}>{r.name}</div>
        )}
        <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>{sub}</div>
      </div>
      <ScorePill score={r.similarityScore} />
    </div>
  )
}

export default function PlayerCompsCard({ playerId, side = 'hitter', divLabel, season = CURRENT_SEASON }) {
  const T = usePlayerProfileTheme()
  const titleNoun = side === 'pitcher' ? 'Pitchers' : 'Players'
  const { data, loading } = useApi(
    playerId ? `/players/${playerId}/comps` : null,
    { side, season }, [playerId, side, season],
  )

  // mlb is an array (top 3). Tolerate the older single-object shape in case a
  // stale cached response is served mid-deploy.
  const mlbRaw = data?.mlb
  const mlb = Array.isArray(mlbRaw) ? mlbRaw : (mlbRaw ? [mlbRaw] : [])
  const nwTop = (data?.nw || [])[0] || null
  const hasComps = mlb.length > 0 || !!nwTop
  const fullLink = `/player-comps?side=${side}&player_id=${playerId}`

  return (
    <div className="rounded-md p-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2" style={{ color: T.text, borderColor: T.text }}>
        <span>Statistically Similar {titleNoun}</span>
        <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>
          {divLabel ? `${divLabel} · ` : ''}{season}
        </span>
      </h2>

      {loading && !data && (
        <div className="text-[12px] py-4 text-center" style={{ color: T.textMuted }}>Finding comparables…</div>
      )}

      {data && !hasComps && (
        <div className="text-[12px] py-4 text-center" style={{ color: T.textMuted }}>
          Not enough qualifying stats yet to build a comparison.
        </div>
      )}

      {data && hasComps && (
        <>
          {mlb.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>MLB Comparables</span>
                <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Match</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {mlb.map((r) => (
                  <CompRow key={r.id} T={T} r={r} sub={`${r.season ? `${r.season} · ` : ''}MLB`} />
                ))}
              </div>
            </div>
          )}

          {nwTop && (
            <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${T.border}` }}>
              <span className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Closest NW Player</span>
              <div className="mt-2">
                <CompRow T={T} r={nwTop} to={`/player/${nwTop.id}`}
                  sub={`${nwTop.team || ''}${nwTop.level ? ` · ${nwTop.level}` : ''}`} />
              </div>
            </div>
          )}

          <Link to={fullLink} className="inline-block mt-3 text-[12px] font-bold hover:underline" style={{ color: T.accent }}>
            Open full comparison →
          </Link>
        </>
      )}
    </div>
  )
}
