// "Statistically Similar Players" card for the player profile pages.
//
// Fetches /players/{id}/comps and shows the player's archetype, their top NW
// comparables, and their closest recent MLB season, with a link to the full
// Player Comparison tool. Pass `side` so it matches whichever side the profile
// page is currently showing (matters for two-way players).
//
// Powered by the comp model built by interns Trevor Kazahaya and Connor Broschard.

import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePlayerProfileTheme, pctColor, divisionBadge } from './playerProfile/shared'

function ScorePill({ score }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full text-white text-[11px] font-extrabold shrink-0"
      style={{ background: pctColor(score), width: 30, height: 30 }}>
      {Math.round(score)}
    </span>
  )
}

export default function PlayerCompsCard({ playerId, side = 'hitter', divLabel, season = 2026 }) {
  const T = usePlayerProfileTheme()
  const titleNoun = side === 'pitcher' ? 'Pitchers' : 'Players'
  const { data, loading } = useApi(
    playerId ? `/players/${playerId}/comps` : null,
    { side, season }, [playerId, side, season],
  )

  const arche = data?.archetype
  const nw = data?.nw || []
  const mlb = data?.mlb || null
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

      {data && nw.length === 0 && (
        <div className="text-[12px] py-4 text-center" style={{ color: T.textMuted }}>
          Not enough qualifying stats yet to build a comparison.
        </div>
      )}

      {data && nw.length > 0 && (
        <>
          {arche && (
            <div className="mb-3">
              <span className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Archetype</span>
              <div className="text-[14px] font-extrabold leading-tight" style={{ color: T.gold }}>{arche.title}</div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {nw.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2.5">
                <span className="text-[11px] font-bold w-3 text-center shrink-0" style={{ color: T.textLight }}>{i + 1}</span>
                <ScorePill score={r.similarityScore} />
                <div className="min-w-0 flex-1">
                  <Link to={`/player/${r.id}`} className="text-[13px] font-semibold hover:underline truncate block" style={{ color: T.accent }}>
                    {r.name}
                  </Link>
                  <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>
                    {r.team}{r.level ? ` · ${r.level}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {mlb && (
            <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${T.border}` }}>
              <span className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Closest MLB season</span>
              <div className="flex items-center gap-2.5 mt-1">
                <ScorePill score={mlb.similarityScore} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate" style={{ color: T.text }}>{mlb.name}</div>
                  <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>
                    {mlb.team}{mlb.season ? ` · ${mlb.season}` : ''} · MLB
                  </div>
                </div>
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
