// TopMoments — biggest plays + clutch leaderboards of 2026.
//
// Four tabs:
//   1. Hitter Moments  — top WPA from the BATTER's perspective
//   2. Pitcher Moments — top WPA from the PITCHER's perspective
//   3. Top Hitters     — cumulative WPA leaderboard
//   4. Top Pitchers    — cumulative WPA leaderboard for pitchers
//
// Hitter and pitcher moments are computed from the SAME events but
// sorted differently (and with WPA framed from each side's view).
// A walk-off HR shows up as a hitter moment at +0.50 batter WPA.
// A bases-loaded strikeout in a tied 9th shows as a pitcher moment
// at +0.40 pitcher WPA (the batter's wpa_batter was -0.40 there).

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTopMoments } from '../hooks/useApi'

const SEASON = 2026

export default function TopMoments() {
  const [tab, setTab] = useState('hitter_moments')
  const { data, loading, error } = useTopMoments(SEASON)

  return (
    <div className="max-w-5xl mx-auto px-4 py-5">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Top Moments of 2026</h1>
      <p className="text-xs text-gray-500 mb-4 max-w-2xl">
        The most-clutch plays and players of the season — measured by Win
        Probability Added on every plate appearance with PBP coverage. Hitter
        and pitcher moments come from the same events, surfaced from each
        side's perspective.
      </p>

      <div className="flex gap-0.5 mb-5 bg-gray-100 rounded-lg p-0.5 w-fit flex-wrap">
        {[
          { id: 'hitter_moments',  label: 'Hitter Moments' },
          { id: 'pitcher_moments', label: 'Pitcher Moments' },
          { id: 'hitters',         label: 'Top Hitters' },
          { id: 'pitchers',        label: 'Top Pitchers' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded text-xs font-medium ${
              tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <Empty icon="⏳" text="Loading the season's biggest swings..." spin />}
      {error && <div className="text-red-500 text-sm py-6 text-center">{error}</div>}

      {data && tab === 'hitter_moments' && (
        <MomentsView moments={data.hitter_moments} perspective="batter" />
      )}
      {data && tab === 'pitcher_moments' && (
        <MomentsView moments={data.pitcher_moments} perspective="pitcher" />
      )}
      {data && tab === 'hitters' && (
        <LeaderboardView
          rows={data.top_hitters}
          minThreshold={data.min_pa}
          unit="PA"
          subjectLabel="hitters"
        />
      )}
      {data && tab === 'pitchers' && (
        <LeaderboardView
          rows={data.top_pitchers}
          minThreshold={data.min_pa}
          unit="BF"
          subjectLabel="pitchers"
        />
      )}
    </div>
  )
}

// ── Moments view ───────────────────────────────────────────────
function MomentsView({ moments, perspective }) {
  if (!moments || moments.length === 0) {
    return <Empty icon="📭" text="No moments yet — check back as the season builds." />
  }
  const [hero, ...rest] = moments
  const headline = perspective === 'batter'
    ? "The biggest swings hitters made all year"
    : "The biggest jams pitchers worked out of"
  return (
    <div className="space-y-4">
      <HeroMoment moment={hero} rank={1} perspective={perspective} />
      {rest.length > 0 && (
        <div>
          <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2 font-semibold">
            {headline}
          </h2>
          <div className="space-y-2">
            {rest.map((m, i) => (
              <MomentCard key={`${m.id}-${perspective}`} moment={m} rank={i + 2}
                           perspective={perspective} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Hero card — large, gradient background, full context.
function HeroMoment({ moment, rank, perspective }) {
  const m = moment
  const featured = perspective === 'batter' ? m.batter : m.pitcher
  const opposing = perspective === 'batter' ? m.pitcher : m.batter
  const inn = `${m.half === 'top' ? 'Top' : 'Bot'} ${m.inning}`
  const score = formatScoreContext(m, perspective)
  const bases = formatBases(m.bases_before)
  const outs = m.outs_before == null ? '—' : `${m.outs_before} out${m.outs_before === 1 ? '' : 's'}`
  const count = (m.balls_before == null || m.strikes_before == null)
    ? null : `${m.balls_before}-${m.strikes_before} count`
  const wpa = m.wpa
  const wpaSign = wpa >= 0 ? '+' : ''
  const result = formatResultType(m.result_type)
  const date = m.game_date
    ? new Date(m.game_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '—'
  const headlineLabel = perspective === 'batter'
    ? '#1 · biggest hitter swing of 2026'
    : '#1 · biggest pitcher escape of 2026'
  const wpaLabel = perspective === 'batter' ? 'batter WPA' : 'pitcher WPA'
  return (
    <div className="bg-gradient-to-br from-pnw-forest to-pnw-green text-white rounded-xl p-5 shadow-md">
      <div className="flex items-baseline justify-between mb-3 gap-2">
        <span className="text-[10px] uppercase tracking-widest text-teal-200/70 font-semibold">
          {headlineLabel}
        </span>
        <span className="text-3xl sm:text-4xl font-bold tabular-nums shrink-0">
          {wpaSign}{wpa.toFixed(2)}
          <span className="text-xs font-normal opacity-70 ml-1">{wpaLabel}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <Link
          to={`/players/${featured.id}`}
          className="text-xl sm:text-2xl font-bold text-white hover:underline"
        >
          {featured.name}
        </Link>
        <span className="text-teal-200/80 text-sm">
          {perspective === 'batter'
            ? `${result.toLowerCase()} off ${opposing.name}`
            : `retires ${opposing.name} on ${result.toLowerCase()}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-teal-100/90 mb-3">
        <span className="flex items-center gap-1.5">
          {m.game.away_logo && <img src={m.game.away_logo} alt="" className="h-4 w-4 object-contain" />}
          {m.game.away_short}
        </span>
        <span className="text-teal-300/60">@</span>
        <span className="flex items-center gap-1.5">
          {m.game.home_logo && <img src={m.game.home_logo} alt="" className="h-4 w-4 object-contain" />}
          {m.game.home_short}
        </span>
        <span className="text-teal-300/40">·</span>
        <span>{date}</span>
        <span className="text-teal-300/40">·</span>
        <span>final {m.game.final_away}-{m.game.final_home}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
        <HeroStat label="Inning" value={inn} />
        <HeroStat label="Score" value={score} />
        <HeroStat label="Bases · Outs" value={`${bases} · ${outs}`} />
        <HeroStat label="WP swing" value={`${(m.wp_before * 100).toFixed(0)}% → ${(m.wp_after * 100).toFixed(0)}%`} />
      </div>

      {m.result_text && (
        <div className="bg-white/10 rounded p-3 text-[12px] text-teal-50 italic leading-snug">
          "{m.result_text}"
        </div>
      )}
    </div>
  )
}

function HeroStat({ label, value }) {
  return (
    <div className="bg-white/10 rounded p-2">
      <div className="text-[9px] uppercase tracking-wide text-teal-200/70">{label}</div>
      <div className="text-sm font-semibold truncate">{value}</div>
    </div>
  )
}

// Compact card for moments 2-25. Click to expand the full narrative.
function MomentCard({ moment, rank, perspective }) {
  const [expanded, setExpanded] = useState(false)
  const m = moment
  const featured = perspective === 'batter' ? m.batter : m.pitcher
  const opposing = perspective === 'batter' ? m.pitcher : m.batter
  const inn = `${m.half === 'top' ? 'T' : 'B'}${m.inning}`
  const score = formatScoreContext(m, perspective)
  const bases = formatBases(m.bases_before)
  const outs = m.outs_before == null ? '—' : `${m.outs_before}`
  const count = (m.balls_before == null || m.strikes_before == null)
    ? null : `${m.balls_before}-${m.strikes_before}`
  const wpa = m.wpa
  const wpaSign = wpa >= 0 ? '+' : ''
  const result = formatResultType(m.result_type)
  const date = m.game_date
    ? new Date(m.game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—'
  const wpaColor = perspective === 'batter' ? 'text-emerald-700' : 'text-rose-700'
  const tag = perspective === 'batter' ? 'HIT' : 'PIT'
  const tagBg = perspective === 'batter' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
      >
        <span className="text-[10px] font-bold text-gray-400 tabular-nums w-7 shrink-0">
          #{rank}
        </span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${tagBg}`}>
          {tag}
        </span>
        <span className={`text-lg font-bold tabular-nums w-16 shrink-0 ${wpaColor}`}>
          {wpaSign}{wpa.toFixed(2)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <Link
              to={`/players/${featured.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-semibold text-gray-900 hover:underline truncate"
            >
              {featured.name}
            </Link>
            <span className="text-xs text-gray-500 truncate">{result.toLowerCase()}</span>
            <span className="text-xs text-gray-400">vs</span>
            <Link
              to={`/players/${opposing.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-gray-600 hover:underline truncate"
            >
              {opposing.name}
            </Link>
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1">
              {m.game.away_logo && <img src={m.game.away_logo} alt="" className="h-3 w-3 object-contain" />}
              {m.game.away_short}
            </span>
            <span className="text-gray-300">@</span>
            <span className="inline-flex items-center gap-1">
              {m.game.home_logo && <img src={m.game.home_logo} alt="" className="h-3 w-3 object-contain" />}
              {m.game.home_short}
            </span>
            <span className="text-gray-300">·</span>
            <span>{date}</span>
            <span className="text-gray-300">·</span>
            <span className="tabular-nums">{inn}</span>
            <span className="text-gray-300">·</span>
            <span className="tabular-nums">{score}</span>
            <span className="text-gray-300">·</span>
            <span>{bases}, {outs} out</span>
            {count && (
              <>
                <span className="text-gray-300">·</span>
                <span className="tabular-nums">{count}</span>
              </>
            )}
          </div>
        </div>
        <span className={`text-[10px] text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-gray-50 border-t border-gray-100">
          {m.result_text && (
            <div className="text-[12px] text-gray-700 italic leading-snug mb-2">
              "{m.result_text}"
            </div>
          )}
          <div className="text-[11px] text-gray-600">
            Win probability swung from{' '}
            <span className="font-semibold tabular-nums">
              {(m.wp_before * 100).toFixed(0)}%
            </span>{' '}
            to{' '}
            <span className="font-semibold tabular-nums">
              {(m.wp_after * 100).toFixed(0)}%
            </span>
            {perspective === 'batter'
              ? ` for the batting team`
              : ` for the pitcher's team`}
            .
          </div>
        </div>
      )}
    </div>
  )
}

// ── Leaderboard view ───────────────────────────────────────────
function LeaderboardView({ rows, minThreshold, unit, subjectLabel }) {
  if (!rows || rows.length === 0) {
    return <Empty icon="📊" text={`No ${subjectLabel} yet with enough sample.`} />
  }
  return (
    <div>
      <p className="text-[11px] text-gray-500 mb-3 leading-snug">
        Total Win Probability Added across the season. Minimum {minThreshold}{' '}
        {unit} to qualify. Higher = more wins contributed in the moments
        that matter.
      </p>
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-400 border-b border-gray-100 bg-gray-50">
              <th className="py-2 pl-3 text-center w-10">#</th>
              <th className="py-2 text-left">Player</th>
              <th className="py-2 text-left">Team</th>
              <th className="py-2 text-center w-14">Pos</th>
              <th className="py-2 text-right">Total WPA</th>
              <th className="py-2 text-right">Peak</th>
              <th className="py-2 text-right pr-3">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <LeaderboardRow key={r.player_id} row={r} unit={unit} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LeaderboardRow({ row: r, unit }) {
  const wpaSign = r.total_wpa >= 0 ? '+' : ''
  const peakSign = r.peak_wpa != null && r.peak_wpa >= 0 ? '+' : ''
  const wpaColor = r.total_wpa >= 1.5 ? 'text-emerald-700 font-bold' :
                   r.total_wpa >= 0.5 ? 'text-emerald-700' :
                   r.total_wpa <= -0.5 ? 'text-rose-700' : 'text-gray-700'
  const rowAccent = r.rank === 1 ? 'bg-amber-50' :
                    r.rank <= 3 ? 'bg-amber-50/40' :
                    'bg-white'
  return (
    <tr className={`border-b border-gray-50 last:border-0 ${rowAccent} hover:bg-gray-50`}>
      <td className="py-1.5 pl-3 text-center text-gray-500 tabular-nums font-semibold">
        {r.rank}
      </td>
      <td className="py-1.5">
        <Link
          to={`/players/${r.player_id}`}
          className="text-sm font-semibold text-gray-900 hover:underline"
        >
          {r.name}
        </Link>
      </td>
      <td className="py-1.5">
        <span className="inline-flex items-center gap-1.5 text-gray-600">
          {r.team_logo && <img src={r.team_logo} alt="" className="h-4 w-4 object-contain" />}
          <span className="text-xs">{r.team_short}</span>
          <span className="text-[10px] text-gray-400">{r.division_level}</span>
        </span>
      </td>
      <td className="py-1.5 text-center text-xs text-gray-500">
        {r.position || '?'}
      </td>
      <td className={`py-1.5 text-right tabular-nums text-sm ${wpaColor}`}>
        {wpaSign}{r.total_wpa.toFixed(2)}
      </td>
      <td className="py-1.5 text-right tabular-nums text-xs text-gray-600">
        {r.peak_wpa == null ? '—' : `${peakSign}${r.peak_wpa.toFixed(2)}`}
      </td>
      <td className="py-1.5 text-right pr-3 tabular-nums text-xs text-gray-500">
        {unit === 'PA' ? r.pa : r.bf}
      </td>
    </tr>
  )
}

// ── Helpers ────────────────────────────────────────────────────

// Translate '000'-'111' bases string to a coach-readable label.
function formatBases(b) {
  if (!b || b.length !== 3) return '—'
  const r1 = b[0] === '1', r2 = b[1] === '1', r3 = b[2] === '1'
  if (!r1 && !r2 && !r3) return 'bases empty'
  if (r1 && r2 && r3) return 'bases loaded'
  if (r2 && r3) return 'runners on 2nd & 3rd'
  if (r1 && r3) return 'runners on 1st & 3rd'
  if (r1 && r2) return 'runners on 1st & 2nd'
  if (r3) return 'runner on 3rd'
  if (r2) return 'runner on 2nd'
  if (r1) return 'runner on 1st'
  return '—'
}

// Render score in coach-readable form FROM the perspective shown.
//   batter perspective → "down 3, runners on" type narrative
//   pitcher perspective → flip the lead description
function formatScoreContext(m, perspective) {
  const bat = m.bat_score_before
  const fld = m.fld_score_before
  if (bat == null || fld == null) return '—'
  if (perspective === 'batter') {
    if (bat > fld) return `up ${bat - fld} (${bat}-${fld})`
    if (bat < fld) return `down ${fld - bat} (${bat}-${fld})`
    return `tied ${bat}-${fld}`
  }
  // Pitcher view — flip leading/trailing language
  if (fld > bat) return `up ${fld - bat} (${fld}-${bat})`
  if (fld < bat) return `down ${bat - fld} (${fld}-${bat})`
  return `tied ${fld}-${bat}`
}

function formatResultType(rt) {
  const map = {
    home_run: 'Home run',
    triple: 'Triple',
    double: 'Double',
    single: 'Single',
    walk: 'Walk',
    intentional_walk: 'IBB',
    hbp: 'HBP',
    strikeout_swinging: 'K (swinging)',
    strikeout_looking: 'K (looking)',
    ground_out: 'Ground out',
    fly_out: 'Fly out',
    line_out: 'Line out',
    pop_out: 'Pop out',
    sac_fly: 'Sac fly',
    sac_bunt: 'Sac bunt',
    fielders_choice: "Fielder's choice",
    error: 'Reached on error',
    double_play: 'Double play',
    triple_play: 'Triple play',
    catcher_interference: "Catcher's int.",
  }
  return map[rt] || rt || '—'
}

function Empty({ icon, text, spin }) {
  return (
    <div className="text-center py-16 text-gray-400">
      <div className={`text-3xl mb-2 ${spin ? 'animate-spin' : ''}`}>{icon}</div>
      <div className="text-sm">{text}</div>
    </div>
  )
}
