// PlayerScouting — opposing-coach scouting report.
//
// Different from PlayerDetail (which is fan-facing): this page is
// framed for the OPPOSING coach. Surfaces strengths to avoid,
// weaknesses to attack, situational tendencies, and the PBP-derived
// pitch-level data in a curated layout. Auto-generates plain-English
// narrative bullets from percentile rankings and PBP profile.

import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  useApi,
  usePlayer,
  usePlayerPitchLevelStats,
  usePlayerPitchLevelStatsPitcher,
} from '../hooks/useApi'

const SEASON = 2026

export default function PlayerScouting() {
  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPlayerId, setSelectedPlayerId] = useState(null)

  const { data: searchData } = useApi(
    searchTerm.length >= 2 ? '/players/search' : null,
    { q: searchTerm, limit: 20 },
    [searchTerm]
  )
  const searchResults = searchData?.players || []

  const handleSearch = (e) => {
    e.preventDefault()
    setSearchTerm(query)
    setSelectedPlayerId(null)
  }

  const handleSelectPlayer = (pid) => {
    setSelectedPlayerId(pid)
    setSearchTerm('')      // collapse the result list once a player is picked
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Player Scouting</h1>
      <p className="text-xs text-gray-500 mb-4">
        Opposing-coach scouting report. Strengths to avoid, weaknesses to
        exploit, and PBP-derived tendencies for any 2026 player.
      </p>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a player by name..."
          className="flex-1 max-w-md rounded border border-gray-300 px-3 py-1.5 text-sm
                     focus:ring-2 focus:ring-pnw-sky focus:border-transparent"
        />
        <button
          type="submit"
          className="px-3 py-1.5 bg-pnw-green text-white rounded text-sm font-medium hover:bg-pnw-forest"
        >
          Search
        </button>
      </form>

      {searchTerm && searchResults.length > 0 && !selectedPlayerId && (
        <SearchResults results={searchResults} onSelect={handleSelectPlayer} />
      )}

      {!selectedPlayerId && !searchTerm && (
        <Empty icon="🔍" text="Search for a player to scout" />
      )}

      {selectedPlayerId && (
        <ScoutingReport playerId={selectedPlayerId} />
      )}
    </div>
  )
}

// ── Search results dropdown ────────────────────────────────────
function SearchResults({ results, onSelect }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-4">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-semibold text-gray-700">
          {results.length} result{results.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
        {results.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
          >
            {p.logo_url && (
              <img src={p.logo_url} alt="" className="h-5 w-5 object-contain" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900">
                {p.first_name} {p.last_name}
              </div>
              <div className="text-[11px] text-gray-500">
                {p.position || '?'} · {p.team_short || p.team_name || '—'} · {p.division_level || '—'}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main scouting report ───────────────────────────────────────
function ScoutingReport({ playerId }) {
  const { data: profile, loading: profileLoading } = usePlayer(playerId)
  const player = profile?.player

  // Try BOTH hitter and pitcher endpoints — Saelens-style two-way
  // players need both. Use the position to decide which side leads.
  const isPitcher = (player?.position || '').toUpperCase() === 'P'

  const { data: hitterStats } = usePlayerPitchLevelStats(playerId, SEASON)
  const { data: pitcherStats } = usePlayerPitchLevelStatsPitcher(playerId, SEASON)

  if (profileLoading || !player) {
    return <Empty icon="⏳" text="Loading scouting report..." spin />
  }

  return (
    <div className="space-y-4">
      <PlayerHeader player={player} />

      {isPitcher ? (
        <PitcherReport
          player={player}
          profile={profile}
          stats={pitcherStats}
        />
      ) : (
        <HitterReport
          player={player}
          profile={profile}
          stats={hitterStats}
        />
      )}

      {/* Both-sides players show the secondary side too */}
      {!isPitcher && profile?.pitching_stats?.length > 0 && pitcherStats && (
        <div className="border-t border-gray-200 pt-4 mt-4">
          <h2 className="text-sm font-bold text-gray-700 mb-2">
            Also pitches — secondary scouting
          </h2>
          <PitcherReport
            player={player}
            profile={profile}
            stats={pitcherStats}
          />
        </div>
      )}
      {isPitcher && profile?.batting_stats?.length > 0 && hitterStats && (
        <div className="border-t border-gray-200 pt-4 mt-4">
          <h2 className="text-sm font-bold text-gray-700 mb-2">
            Also hits — secondary scouting
          </h2>
          <HitterReport
            player={player}
            profile={profile}
            stats={hitterStats}
          />
        </div>
      )}
    </div>
  )
}

// ── Player header ──────────────────────────────────────────────
function PlayerHeader({ player }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4">
      {player.headshot_url && (
        <img
          src={player.headshot_url}
          alt=""
          className="h-16 w-16 object-cover rounded border border-gray-200"
          onError={(e) => { e.target.style.display = 'none' }}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-gray-900">
            {player.first_name} {player.last_name}
          </h2>
          <Link
            to={`/players/${player.id}`}
            className="text-xs text-pnw-sky hover:underline"
          >
            full profile →
          </Link>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-600 mt-1">
          {player.logo_url && (
            <img src={player.logo_url} alt="" className="h-4 w-4 object-contain" />
          )}
          <span className="font-medium">{player.team_short || player.team_name}</span>
          <span className="text-gray-400">·</span>
          <span>{player.position || '?'}</span>
          {player.bats && (
            <>
              <span className="text-gray-400">·</span>
              <span>Bats {player.bats}</span>
            </>
          )}
          {player.throws && (
            <>
              <span className="text-gray-400">·</span>
              <span>Throws {player.throws}</span>
            </>
          )}
          {player.year_in_school && (
            <>
              <span className="text-gray-400">·</span>
              <span>{player.year_in_school}</span>
            </>
          )}
        </div>
        {player.hometown && (
          <div className="text-[11px] text-gray-500 mt-0.5">
            {player.hometown}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Hitter report ──────────────────────────────────────────────
function HitterReport({ player, profile, stats }) {
  const battingStats = profile?.batting_stats || []
  const current = battingStats[battingStats.length - 1] || {}
  const percentiles = profile?.batting_percentiles || {}
  const discipline = stats?.discipline || {}
  const cp = stats?.contact_profile || {}

  const narratives = useMemo(
    () => generateHitterNarrative(percentiles, discipline, cp, player),
    [percentiles, discipline, cp, player]
  )
  const { strengths, weaknesses } = useMemo(
    () => splitStrengthsWeaknesses(percentiles, HITTER_METRIC_LABELS),
    [percentiles]
  )

  return (
    <div className="space-y-4">
      {/* Narrative bullets */}
      {narratives.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs font-bold text-blue-900 uppercase mb-2">
            Scouting Summary
          </div>
          <ul className="space-y-1.5 text-sm text-gray-800">
            {narratives.map((n, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-blue-500 shrink-0">·</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Strengths / Weaknesses */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PercentilePanel
          title="Strengths"
          subtitle="Avoid pitching to these"
          metrics={strengths}
          accent="green"
        />
        <PercentilePanel
          title="Weaknesses"
          subtitle="Attack here"
          metrics={weaknesses}
          accent="red"
        />
      </div>

      {/* Stat line */}
      <StatLineCard
        label="2026 line"
        items={[
          { label: 'AVG', value: fmtAvg(current.batting_avg) },
          { label: 'OBP', value: fmtAvg(current.on_base_pct) },
          { label: 'SLG', value: fmtAvg(current.slugging_pct) },
          { label: 'wRC+', value: current.wrc_plus != null ? Math.round(current.wrc_plus) : '—' },
          { label: 'HR', value: current.home_runs ?? '—' },
          { label: 'PA', value: current.plate_appearances ?? '—' },
          { label: 'BB%', value: fmtPct(current.bb_pct) },
          { label: 'K%', value: fmtPct(current.k_pct) },
        ]}
      />

      {/* Contact profile */}
      {(cp.bb_total || 0) > 0 && (
        <ContactProfileCard cp={cp} bats={player.bats} />
      )}

      {/* Approach grid */}
      {discipline.tracked_pa > 0 && (
        <ApproachCard discipline={discipline} side="hitter" />
      )}

      {/* WPA / LI summary */}
      <ImpactCard discipline={discipline} side="hitter" />
    </div>
  )
}

// ── Pitcher report ─────────────────────────────────────────────
function PitcherReport({ player, profile, stats }) {
  const pitchingStats = profile?.pitching_stats || []
  const current = pitchingStats[pitchingStats.length - 1] || {}
  const percentiles = profile?.pitching_percentiles || {}
  const discipline = stats?.discipline || {}
  const ocp = stats?.opp_contact_profile || {}

  const narratives = useMemo(
    () => generatePitcherNarrative(percentiles, discipline, ocp, player),
    [percentiles, discipline, ocp, player]
  )
  const { strengths, weaknesses } = useMemo(
    () => splitStrengthsWeaknesses(percentiles, PITCHER_METRIC_LABELS),
    [percentiles]
  )

  return (
    <div className="space-y-4">
      {narratives.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs font-bold text-blue-900 uppercase mb-2">
            Scouting Summary
          </div>
          <ul className="space-y-1.5 text-sm text-gray-800">
            {narratives.map((n, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-blue-500 shrink-0">·</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PercentilePanel
          title="Strengths"
          subtitle="Don't expect to do this well"
          metrics={strengths}
          accent="green"
        />
        <PercentilePanel
          title="Weaknesses"
          subtitle="Where he's hittable"
          metrics={weaknesses}
          accent="red"
        />
      </div>

      <StatLineCard
        label="2026 line"
        items={[
          { label: 'ERA', value: current.era != null ? current.era.toFixed(2) : '—' },
          { label: 'FIP', value: current.fip != null ? current.fip.toFixed(2) : '—' },
          { label: 'IP', value: current.innings_pitched != null ? current.innings_pitched.toFixed(1) : '—' },
          { label: 'W-L', value: `${current.wins ?? 0}-${current.losses ?? 0}` },
          { label: 'K/9', value: current.k_per_9 != null ? current.k_per_9.toFixed(2) : '—' },
          { label: 'BB/9', value: current.bb_per_9 != null ? current.bb_per_9.toFixed(2) : '—' },
          { label: 'HR/9', value: current.hr_per_9 != null ? current.hr_per_9.toFixed(2) : '—' },
          { label: 'WHIP', value: current.whip != null ? current.whip.toFixed(2) : '—' },
        ]}
      />

      {(ocp.bb_total || 0) > 0 && (
        <OppContactCard ocp={ocp} />
      )}

      {discipline.tracked_pa > 0 && (
        <ApproachCard discipline={discipline} side="pitcher" />
      )}

      <ImpactCard discipline={discipline} side="pitcher" />
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function PercentilePanel({ title, subtitle, metrics, accent }) {
  const headerStyle = accent === 'green'
    ? 'bg-emerald-50 border-emerald-200'
    : 'bg-rose-50 border-rose-200'
  const titleStyle = accent === 'green' ? 'text-emerald-900' : 'text-rose-900'
  return (
    <div className={`border rounded-lg overflow-hidden ${headerStyle}`}>
      <div className="px-3 py-2 border-b border-current/10">
        <div className={`text-xs font-bold uppercase ${titleStyle}`}>{title}</div>
        <div className="text-[11px] text-gray-600">{subtitle}</div>
      </div>
      <div className="bg-white p-2">
        {metrics.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-3">
            No qualifying metrics
          </div>
        ) : (
          <ul className="space-y-1">
            {metrics.map((m, i) => (
              <li key={i} className="flex items-center justify-between text-xs">
                <span className="text-gray-700">{m.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-gray-500 tabular-nums">{m.valueDisplay}</span>
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                      m.percentile >= 70 ? 'bg-emerald-100 text-emerald-800' :
                      m.percentile <= 30 ? 'bg-rose-100 text-rose-800' :
                      'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {m.percentile}%ile
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StatLineCard({ label, items }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-bold text-gray-900 uppercase">{label}</span>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-px bg-gray-100">
        {items.map((item, i) => (
          <div key={i} className="bg-white p-2 text-center">
            <div className="text-[10px] uppercase text-gray-400">{item.label}</div>
            <div className="text-sm font-bold text-gray-900 tabular-nums">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ContactProfileCard({ cp, bats }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-baseline justify-between">
        <span className="text-xs font-bold text-gray-900 uppercase">Contact Profile</span>
        <span className="text-[10px] text-gray-500">{cp.bb_total || 0} BIP{bats ? ` · bats ${bats}` : ''}</span>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-px bg-gray-100">
        <ContactTile label="GB%" value={cp.gb_pct} />
        <ContactTile label="LD%" value={cp.ld_pct} />
        <ContactTile label="FB%" value={cp.fb_pct} />
        <ContactTile label="PU%" value={cp.pu_pct} />
        <ContactTile label="Pull%" value={cp.pull_pct} />
        <ContactTile label="Center%" value={cp.center_pct} />
        <ContactTile label="Oppo%" value={cp.oppo_pct} />
      </div>
    </div>
  )
}

function OppContactCard({ ocp }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-baseline justify-between">
        <span className="text-xs font-bold text-gray-900 uppercase">Opponent Contact (against)</span>
        <span className="text-[10px] text-gray-500">{ocp.bb_total || 0} BIP allowed</span>
      </div>
      <div className="grid grid-cols-4 gap-px bg-gray-100">
        <ContactTile label="GB%" value={ocp.gb_pct} />
        <ContactTile label="LD%" value={ocp.ld_pct} />
        <ContactTile label="FB%" value={ocp.fb_pct} />
        <ContactTile label="PU%" value={ocp.pu_pct} />
      </div>
    </div>
  )
}

function ContactTile({ label, value }) {
  const display = value == null ? '—' : `${(value * 100).toFixed(0)}%`
  return (
    <div className="bg-white p-2 text-center">
      <div className="text-[10px] uppercase text-gray-400">{label}</div>
      <div className="text-sm font-bold text-gray-900 tabular-nums">{display}</div>
    </div>
  )
}

function ApproachCard({ discipline, side }) {
  const d = discipline
  const tiles = side === 'hitter' ? [
    { label: '1st-P Swing%', value: d.first_pitch_swing_pct },
    { label: '1st-P Strike%', value: d.first_pitch_strike_pct },
    { label: '0-0 BIP%', value: d.first_pitch_in_play_pct },
    { label: 'Whiff%', value: d.whiff_pct },
    { label: 'Putaway% (vs him)', value: d.putaway_pct },
    { label: 'P/PA', value: d.pitches_per_pa, fmt: 'num2' },
  ] : [
    { label: 'Strike%', value: d.strike_pct },
    { label: '1st-P Strike%', value: d.first_pitch_strike_pct },
    { label: 'Whiff%', value: d.whiff_pct },
    { label: 'Putaway%', value: d.putaway_pct },
    { label: 'P/PA', value: d.pitches_per_pa, fmt: 'num2' },
  ]
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-bold text-gray-900 uppercase">
          {side === 'hitter' ? 'Hitter Approach' : 'Pitcher Approach'}
        </span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-gray-100">
        {tiles.map((t, i) => {
          const display = t.value == null ? '—'
            : t.fmt === 'num2' ? t.value.toFixed(2)
            : `${(t.value * 100).toFixed(1)}%`
          return (
            <div key={i} className="bg-white p-2 text-center">
              <div className="text-[10px] uppercase text-gray-400">{t.label}</div>
              <div className="text-sm font-bold text-gray-900 tabular-nums">{display}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ImpactCard({ discipline, side }) {
  const d = discipline
  const wpa = d.total_wpa
  const peakWpa = d.peak_wpa
  const li = d.avg_li
  const peakLi = d.max_li
  const sign = wpa != null && wpa >= 0 ? '+' : ''
  const peakSign = peakWpa != null && peakWpa >= 0 ? '+' : ''
  const wpaColor = wpa == null ? 'text-gray-400' :
                   wpa >= 0.3 ? 'text-emerald-700' :
                   wpa <= -0.3 ? 'text-rose-700' : 'text-gray-700'
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-bold text-gray-900 uppercase">Impact</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-100">
        <div className="bg-white p-2 text-center">
          <div className="text-[10px] uppercase text-gray-400">Total WPA</div>
          <div className={`text-sm font-bold tabular-nums ${wpaColor}`}>
            {wpa == null ? '—' : `${sign}${wpa.toFixed(2)}`}
          </div>
          <div className="text-[10px] text-gray-400">{d.wpa_pa || 0} {side === 'pitcher' ? 'BF' : 'PA'}</div>
        </div>
        <div className="bg-white p-2 text-center">
          <div className="text-[10px] uppercase text-gray-400">Peak WPA</div>
          <div className="text-sm font-bold text-gray-900 tabular-nums">
            {peakWpa == null ? '—' : `${peakSign}${peakWpa.toFixed(2)}`}
          </div>
        </div>
        <div className="bg-white p-2 text-center">
          <div className="text-[10px] uppercase text-gray-400">Avg LI</div>
          <div className="text-sm font-bold text-gray-900 tabular-nums">
            {li == null ? '—' : li.toFixed(2)}
          </div>
        </div>
        <div className="bg-white p-2 text-center">
          <div className="text-[10px] uppercase text-gray-400">Peak LI</div>
          <div className="text-sm font-bold text-gray-900 tabular-nums">
            {peakLi == null ? '—' : peakLi.toFixed(1)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────

const HITTER_METRIC_LABELS = {
  wrc_plus:        { label: 'wRC+', higherBetter: true, fmt: 'int' },
  woba:            { label: 'wOBA', higherBetter: true, fmt: 'avg' },
  iso:             { label: 'ISO', higherBetter: true, fmt: 'avg' },
  hr_pa_pct:       { label: 'HR/PA', higherBetter: true, fmt: 'pct' },
  sb_per_pa:       { label: 'SB/PA', higherBetter: true, fmt: 'pct' },
  k_pct:           { label: 'K%', higherBetter: false, fmt: 'pct' },
  bb_pct:          { label: 'BB%', higherBetter: true, fmt: 'pct' },
  contact_pct:     { label: 'Contact%', higherBetter: true, fmt: 'pct' },
  air_pull_pct:    { label: 'AIRPULL%', higherBetter: true, fmt: 'pct' },
  offensive_war:   { label: 'WAR', higherBetter: true, fmt: 'war' },
  wpa:             { label: 'WPA', higherBetter: true, fmt: 'wpa' },
}
const PITCHER_METRIC_LABELS = {
  k_pct:           { label: 'K%', higherBetter: true, fmt: 'pct' },
  bb_pct:          { label: 'BB%', higherBetter: false, fmt: 'pct' },
  fip:             { label: 'FIP', higherBetter: false, fmt: 'era' },
  siera:           { label: 'SIERA', higherBetter: false, fmt: 'era' },
  hr_pa_pct:       { label: 'HR/PA', higherBetter: false, fmt: 'pct' },
  opp_woba:        { label: 'opp wOBA', higherBetter: false, fmt: 'avg' },
  strike_pct:      { label: 'Strike%', higherBetter: true, fmt: 'pct' },
  first_pitch_strike_pct: { label: 'FPS%', higherBetter: true, fmt: 'pct' },
  whiff_pct:       { label: 'Whiff%', higherBetter: true, fmt: 'pct' },
  opp_air_pull_pct: { label: 'opp AIRPULL%', higherBetter: false, fmt: 'pct' },
  pitching_war:    { label: 'WAR', higherBetter: true, fmt: 'war' },
  wpa:             { label: 'WPA', higherBetter: true, fmt: 'wpa' },
}

function splitStrengthsWeaknesses(percentiles, labelMap) {
  const items = []
  for (const [key, p] of Object.entries(percentiles || {})) {
    const meta = labelMap[key]
    if (!meta || p == null) continue
    const value = p.value
    const percentile = p.percentile
    if (percentile == null || value == null) continue
    items.push({
      key,
      label: meta.label,
      value,
      valueDisplay: formatValue(value, meta.fmt),
      percentile,
      higherBetter: meta.higherBetter,
    })
  }
  // Strengths: top 4 by player-favorable percentile
  // Weaknesses: bottom 4 by player-favorable percentile
  items.sort((a, b) => b.percentile - a.percentile)
  const strengths = items.filter(i => i.percentile >= 65).slice(0, 4)
  const weaknesses = [...items]
    .sort((a, b) => a.percentile - b.percentile)
    .filter(i => i.percentile <= 35)
    .slice(0, 4)
  return { strengths, weaknesses }
}

// Auto-generate plain-English bullets summarizing a hitter's profile.
function generateHitterNarrative(percentiles, discipline, cp, player) {
  const out = []

  // Power vs slap
  const iso = percentiles.iso?.percentile
  const hr = percentiles.hr_pa_pct?.percentile
  if (iso != null && iso >= 80) {
    out.push(`Plus power (${iso}th-percentile ISO). Don't leave anything in the zone.`)
  } else if (iso != null && iso <= 25) {
    out.push(`Light bat (${iso}th-percentile ISO). Attack the zone — extra-base damage unlikely.`)
  }

  // Contact / discipline
  const k = percentiles.k_pct?.percentile
  const bb = percentiles.bb_pct?.percentile
  if (k != null && k >= 80) {
    out.push(`Top-tier contact ability (${k}th-percentile K%). Hard to put away.`)
  } else if (k != null && k <= 25) {
    out.push(`Strikeout-prone (${k}th-percentile K%). Get to two strikes and finish him.`)
  }
  if (bb != null && bb >= 80) {
    out.push(`Patient hitter (${bb}th-percentile BB%) — won't chase, throw strikes early.`)
  }

  // Spray + air pull
  if (cp && cp.bb_total >= 20) {
    if (cp.pull_pct != null && cp.pull_pct >= 0.50) {
      out.push(`Pull-heavy (${(cp.pull_pct * 100).toFixed(0)}% pull). Shift accordingly.`)
    } else if (cp.oppo_pct != null && cp.oppo_pct >= 0.35) {
      out.push(`Goes the other way often (${(cp.oppo_pct * 100).toFixed(0)}% oppo) — don't sell out on the pull.`)
    }
    if (cp.fb_pct != null && cp.fb_pct >= 0.40) {
      out.push(`Fly-ball heavy (${(cp.fb_pct * 100).toFixed(0)}% FB). Keep the ball down.`)
    } else if (cp.gb_pct != null && cp.gb_pct >= 0.55) {
      out.push(`Ground-ball-heavy (${(cp.gb_pct * 100).toFixed(0)}% GB). Infield positioning matters.`)
    }
  }

  // First-pitch behavior
  if (discipline?.first_pitch_swing_pct != null && discipline.tracked_pa >= 30) {
    if (discipline.first_pitch_swing_pct >= 0.45) {
      out.push(`Aggressive on the first pitch (${(discipline.first_pitch_swing_pct * 100).toFixed(0)}% swing). Be careful with first-pitch strikes.`)
    } else if (discipline.first_pitch_swing_pct <= 0.20) {
      out.push(`Lets the first pitch go (${(discipline.first_pitch_swing_pct * 100).toFixed(0)}% swing). Steal strike one.`)
    }
  }

  return out.slice(0, 5)
}

function generatePitcherNarrative(percentiles, discipline, ocp, player) {
  const out = []

  const k = percentiles.k_pct?.percentile
  const bb = percentiles.bb_pct?.percentile
  const fip = percentiles.fip?.percentile
  const fps = percentiles.first_pitch_strike_pct?.percentile

  if (k != null && k >= 80) {
    out.push(`Big strikeout arm (${k}th-percentile K%). Two-strike approach matters.`)
  } else if (k != null && k <= 25) {
    out.push(`Doesn't miss bats (${k}th-percentile K%). Put balls in play — you'll find holes.`)
  }
  if (bb != null && bb >= 75) {
    out.push(`Wild — ${bb}th-percentile BB%. Be patient, take walks.`)
  }
  if (fps != null && fps >= 75) {
    out.push(`Throws first-pitch strikes consistently (${fps}th-percentile FPS%). Don't take strike one for granted.`)
  } else if (fps != null && fps <= 30) {
    out.push(`Behind in counts often (${fps}th-percentile FPS%). Wait for fastball strikes.`)
  }

  if (ocp && ocp.bb_total >= 20) {
    if (ocp.gb_pct != null && ocp.gb_pct >= 0.50) {
      out.push(`Ground-ball pitcher (${(ocp.gb_pct * 100).toFixed(0)}% GB induced). Hit it in the air.`)
    } else if (ocp.fb_pct != null && ocp.fb_pct >= 0.40) {
      out.push(`Fly-ball prone (${(ocp.fb_pct * 100).toFixed(0)}% FB allowed). Lifters can damage him.`)
    }
  }

  return out.slice(0, 5)
}

function formatValue(value, fmt) {
  if (value == null) return '—'
  switch (fmt) {
    case 'pct':  return `${(value * 100).toFixed(1)}%`
    case 'avg':  return value >= 1 ? value.toFixed(3) : value.toFixed(3).replace('0.', '.')
    case 'era':  return value.toFixed(2)
    case 'war':  return value.toFixed(1)
    case 'int':  return Math.round(value).toString()
    case 'wpa':  return (value >= 0 ? '+' : '') + value.toFixed(2)
    default: return String(value)
  }
}
function fmtPct(v) { return v == null ? '—' : `${(v * 100).toFixed(1)}%` }
function fmtAvg(v) { return v == null ? '—' : v >= 1 ? v.toFixed(3) : v.toFixed(3).replace('0.', '.') }

function Empty({ icon, text, spin }) {
  return (
    <div className="text-center py-16 text-gray-400">
      <div className={`text-3xl mb-2 ${spin ? 'animate-spin' : ''}`}>{icon}</div>
      <div className="text-sm">{text}</div>
    </div>
  )
}
