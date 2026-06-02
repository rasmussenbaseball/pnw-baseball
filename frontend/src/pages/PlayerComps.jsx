// Player Comparison Tool — dedicated page (/player-comps).
//
// Productionizes the V1 prototype by interns Trevor Kazahaya and Connor
// Broschard. Pick a Northwest player and find their most statistically similar
// comparables, either inside the NW database or among recent MLB player-seasons.
// All scoring happens server-side (/api/v1/comps); this page is the UI.
//
// Themed via the shared playerProfile primitives so light + dark mode are real.

import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import {
  ProfileShell, SectionCard, RadarChart, PctRow, pctColor,
  divisionBadge, usePlayerProfileTheme,
} from '../components/playerProfile/shared'

const SEASON = 2026

// Per-metric value formatting (matches the backend's `format` hints).
function fmtMetric(format, v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  switch (format) {
    case 'int':  return Math.round(n).toString()
    case 'avg':  return n.toFixed(3).replace(/^0/, '').replace(/^-0/, '-')
    case 'pct':  return `${(n * 100).toFixed(1)}%`
    case 'rate': return n.toFixed(2)
    default:     return String(v)
  }
}

function relColor(label, T) {
  if (label === 'High') return T.great
  if (label === 'Medium') return T.gold
  return T.poor
}

// Last name for a compact column header, skipping generational suffixes so
// "Bobby Witt Jr." shows as "Witt", not "Jr.".
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v'])
function lastName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  let i = parts.length - 1
  while (i > 0 && NAME_SUFFIXES.has(parts[i].toLowerCase())) i--
  return parts[i]
}

// ── Small UI atoms ─────────────────────────────────────────────────────────────
function Pill({ active, onClick, children }) {
  const T = usePlayerProfileTheme()
  return (
    <button onClick={onClick}
      className="px-3.5 py-1.5 rounded-md text-[12px] font-bold tracking-wide transition-colors"
      style={active ? { background: T.accent, color: '#fff' } : { background: T.track, color: T.textMuted }}>
      {children}
    </button>
  )
}

function ScoreBadge({ score }) {
  const c = pctColor(score)
  return (
    <div className="flex flex-col items-center justify-center rounded-full text-white font-extrabold leading-none shrink-0"
      style={{ background: c, width: 54, height: 54 }}>
      <span className="text-[18px]">{Math.round(score)}</span>
      <span className="text-[7.5px] font-bold tracking-widest opacity-90 mt-0.5">SIM</span>
    </div>
  )
}

// Searchable player picker (client-side filter over the eligible list).
function PlayerPicker({ players, value, onChange, placeholder }) {
  const T = usePlayerProfileTheme()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selected = useMemo(() => players.find(p => String(p.id) === String(value)), [players, value])
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return players.slice(0, 40)
    return players.filter(p => (p.name || '').toLowerCase().includes(s)).slice(0, 40)
  }, [players, q])

  return (
    <div className="relative w-full" ref={boxRef}>
      <input
        value={open ? q : (selected ? selected.name : q)}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => { setQ(''); setOpen(true) }}
        placeholder={placeholder || 'Search a player…'}
        className="w-full px-3 py-2 rounded-md text-[13px] outline-none"
        style={{ background: T.card, border: `1px solid ${T.borderStrong}`, color: T.text }}
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-auto rounded-md shadow-lg"
          style={{ background: T.card, border: `1px solid ${T.borderStrong}` }}>
          {matches.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: T.textMuted }}>No players match.</div>
          )}
          {matches.map(p => (
            <button key={p.id}
              onClick={() => { onChange(p.id); setOpen(false); setQ('') }}
              className="w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 hover:opacity-80"
              style={{ color: T.text, borderBottom: `1px solid ${T.rowBorder}` }}>
              <span className="font-semibold truncate">{p.name}</span>
              <span className="text-[11px] ml-auto whitespace-nowrap" style={{ color: T.textMuted }}>
                {p.team}{p.level ? ` · ${p.level}` : ''}{p.qualified === false ? ' · sub' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Select({ label, value, onChange, options, T }) {
  return (
    <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>
      {label}
      <select value={value} onChange={e => onChange(e.target.value)}
        className="px-2 py-1.5 rounded-md text-[12px] font-medium outline-none"
        style={{ background: T.card, border: `1px solid ${T.border}`, color: T.text }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function Check({ label, checked, onChange, T }) {
  return (
    <label className="flex items-center gap-2 text-[12px] font-medium cursor-pointer select-none" style={{ color: T.text }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-current" />
      {label}
    </label>
  )
}

// ── Comp result card ────────────────────────────────────────────────────────────
function CompCard({ rank, result, side, pool, selected }) {
  const T = usePlayerProfileTheme()
  const rel = result.reliabilityRange || {}
  const nameNode = pool === 'nw'
    ? <Link to={`/player/${result.id}`} className="hover:underline" style={{ color: T.accent }}>{result.name}</Link>
    : <span style={{ color: T.text }}>{result.name}</span>
  const sub = pool === 'nw'
    ? `${result.team || ''}${result.level ? ` · ${result.level}` : ''}${(side === 'pitcher' && result.role) ? ` · ${result.role}` : ''}`
    : `${result.team || ''}${result.season ? ` · ${result.season}` : ''} · MLB`

  return (
    <div className="rounded-md p-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-extrabold w-5 text-center shrink-0" style={{ color: T.textLight }}>{rank}</span>
        <ScoreBadge score={result.similarityScore} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold truncate">{nameNode}</div>
          <div className="text-[11.5px] truncate" style={{ color: T.textMuted }}>{sub}</div>
        </div>
        <div className="text-right shrink-0">
          <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white" style={{ background: relColor(rel.label, T) }}>
            {rel.label} confidence
          </span>
          <div className="text-[10.5px] mt-1 tabular-nums" style={{ color: T.textMuted }}>
            range {Math.round(rel.lower)}–{Math.round(rel.upper)}
          </div>
        </div>
      </div>

      <p className="text-[12px] mt-2.5 leading-snug" style={{ color: T.textMuted }}>{result.whyText}</p>

      {/* Side-by-side metric table: selected vs this comp, each with its percentile. */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11.5px] tabular-nums" style={{ color: T.text }}>
          <thead>
            <tr className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>
              <th className="text-left font-bold py-1">Metric</th>
              <th className="text-right font-bold py-1 truncate">{lastName(selected?.name) || 'Selected'}</th>
              <th className="text-right font-bold py-1 w-12">pct</th>
              <th className="text-right font-bold py-1 truncate">{lastName(result.name) || 'Comp'}</th>
              <th className="text-right font-bold py-1 w-12">pct</th>
            </tr>
          </thead>
          <tbody>
            {(result.metricBreakdown || []).slice().sort(
              (a, b) => (result._order?.indexOf(a.key) ?? 0) - (result._order?.indexOf(b.key) ?? 0)
            ).map(b => (
              <tr key={b.key} style={{ borderTop: `1px solid ${T.rowBorder}` }}>
                <td className="text-left py-1 font-semibold" style={{ color: T.textMuted }}>{b.label}</td>
                <td className="text-right py-1 font-bold">{fmtMetric(b.format, b.selectedValue)}</td>
                <td className="text-right py-1">
                  <span className="inline-block w-7 text-center rounded text-white text-[10px] font-bold"
                    style={{ background: pctColor(b.selectedPercentile) }}>{Math.round(b.selectedPercentile)}</span>
                </td>
                <td className="text-right py-1 font-bold">{fmtMetric(b.format, b.comparedValue)}</td>
                <td className="text-right py-1">
                  <span className="inline-block w-7 text-center rounded text-white text-[10px] font-bold"
                    style={{ background: pctColor(b.comparedPercentile) }}>{Math.round(b.comparedPercentile)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────────
export default function PlayerComps() {
  const T = usePlayerProfileTheme()
  const [sp, setSp] = useSearchParams()

  const [side, setSide] = useState(sp.get('side') === 'pitcher' ? 'pitcher' : 'hitter')
  const [pool, setPool] = useState(sp.get('pool') === 'mlb' ? 'mlb' : 'nw')
  const [playerId, setPlayerId] = useState(sp.get('player_id') || '')
  const [posMatch, setPosMatch] = useState('any')
  const [matchHand, setMatchHand] = useState(false)
  const [includeSmall, setIncludeSmall] = useState(false)
  const [level, setLevel] = useState('')
  const [conference, setConference] = useState('')
  const [classYear, setClassYear] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  // Keep the URL in sync so comparisons are shareable / deep-linkable.
  useEffect(() => {
    const next = {}
    if (side !== 'hitter') next.side = side
    if (pool !== 'nw') next.pool = pool
    if (playerId) next.player_id = String(playerId)
    setSp(next, { replace: true })
  }, [side, pool, playerId]) // eslint-disable-line

  // Selectable players for the chosen side (the selected player is always NW).
  const { data: playersData } = useApi('/comps/players', { side, season: SEASON }, [side])
  const players = playersData?.players || []

  // Reset filters that don't apply across a side switch.
  useEffect(() => { setLevel(''); setConference(''); setClassYear('') }, [side])

  // Main comp fetch.
  const compParams = {
    player_id: playerId || '', side, pool, season: SEASON,
    position_match: posMatch, match_handedness: matchHand, include_small: includeSmall,
    level: pool === 'nw' ? level : '', conference: pool === 'nw' ? conference : '',
    class_year: pool === 'nw' ? classYear : '',
  }
  const { data, loading } = useApi(
    playerId ? '/comps' : null, compParams,
    [playerId, side, pool, posMatch, matchHand, includeSmall, level, conference, classYear],
  )

  const selected = data?.selectedPlayer || null
  const config = data?.config
  const metricOrder = (config?.metrics || []).map(m => m.key)
  const results = (data?.results || []).map(r => ({ ...r, _order: metricOrder }))

  // Distinct filter option sets, derived from the loaded player list.
  const levels = useMemo(() => Array.from(new Set(players.map(p => p.level).filter(Boolean))).sort(), [players])
  const confs = useMemo(() => Array.from(new Set(players.map(p => p.conference).filter(Boolean))).sort(), [players])

  const arche = selected?.archetype
  const radarStats = (arche?.traits || []).map(t => ({ label: t.radarLabel || t.label, pct: t.score }))

  const posOptions = side === 'pitcher'
    ? [{ value: 'any', label: 'Any role' }, { value: 'exact', label: 'Same role (SP/RP)' }]
    : [{ value: 'any', label: 'Any position' }, { value: 'family', label: 'Position family' }, { value: 'exact', label: 'Exact position' }]

  return (
    <ProfileShell>
      <div className="max-w-6xl mx-auto px-3 py-5">
        {/* Hero */}
        <div className="mb-4">
          <h1 className="text-[26px] font-extrabold tracking-tight" style={{ color: T.text }}>Player Comparison Tool</h1>
          <p className="text-[13px] mt-1 max-w-3xl" style={{ color: T.textMuted }}>
            Pick a Northwest player to find their most statistically similar comparables, either across the NW
            database or among recent MLB player-seasons. Comps are built on percentile-based stat profiles, so two
            players match when they create value in similar ways, not just when their raw numbers line up.
          </p>
          <p className="text-[11px] mt-1" style={{ color: T.textLight }}>
            Built by NWBB Stats interns Trevor Kazahaya and Connor Broschard.
          </p>
        </div>

        {/* Controls */}
        <SectionCard>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Model</span>
              <div className="flex gap-1.5">
                <Pill active={side === 'hitter'} onClick={() => { setSide('hitter'); setPlayerId('') }}>Hitters</Pill>
                <Pill active={side === 'pitcher'} onClick={() => { setSide('pitcher'); setPlayerId('') }}>Pitchers</Pill>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Compare to</span>
              <div className="flex gap-1.5">
                <Pill active={pool === 'nw'} onClick={() => setPool('nw')}>NW players</Pill>
                <Pill active={pool === 'mlb'} onClick={() => setPool('mlb')}>MLB seasons</Pill>
              </div>
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
              <span className="text-[10.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Player</span>
              <PlayerPicker players={players} value={playerId} onChange={setPlayerId}
                placeholder={`Search a NW ${side}…`} />
            </div>
            <button onClick={() => setShowSettings(s => !s)}
              className="text-[12px] font-bold underline self-end pb-1.5" style={{ color: T.accent }}>
              {showSettings ? 'Hide' : 'Match settings'}
            </button>
          </div>

          {showSettings && (
            <div className="mt-4 pt-4 flex flex-wrap items-end gap-x-5 gap-y-3" style={{ borderTop: `1px solid ${T.border}` }}>
              <Select label="Position match" value={posMatch} onChange={setPosMatch} options={posOptions} T={T} />
              {pool === 'nw' && (
                <>
                  <Select label="Level" value={level} onChange={setLevel}
                    options={[{ value: '', label: 'All levels' }, ...levels.map(l => ({ value: l, label: l }))]} T={T} />
                  <Select label="Conference" value={conference} onChange={setConference}
                    options={[{ value: '', label: 'All conferences' }, ...confs.map(c => ({ value: c, label: c }))]} T={T} />
                  {side === 'hitter' && (
                    <Select label="Class" value={classYear} onChange={setClassYear}
                      options={[{ value: '', label: 'All classes' }, ...['Fr', 'R-Fr', 'So', 'R-So', 'Jr', 'Sr'].map(c => ({ value: c, label: c }))]} T={T} />
                  )}
                </>
              )}
              <div className="flex flex-col gap-1.5 pb-1">
                <Check label={`Match handedness (${side === 'hitter' ? 'bats' : 'throws'})`} checked={matchHand} onChange={setMatchHand} T={T} />
                <Check label="Include small-sample players" checked={includeSmall} onChange={setIncludeSmall} T={T} />
              </div>
            </div>
          )}
        </SectionCard>

        {/* Empty state */}
        {!playerId && (
          <SectionCard>
            <div className="text-center py-10 text-[13px]" style={{ color: T.textMuted }}>
              Search and select a {side === 'hitter' ? 'hitter' : 'pitcher'} above to see their closest comparables.
            </div>
          </SectionCard>
        )}

        {playerId && loading && !data && (
          <SectionCard><div className="text-center py-10 text-[13px]" style={{ color: T.textMuted }}>Computing comparisons…</div></SectionCard>
        )}

        {playerId && data && !selected && (
          <SectionCard>
            <div className="text-center py-10 text-[13px]" style={{ color: T.textMuted }}>
              No comparison available for this player yet. They may not have a complete {config?.thresholdLabel || 'qualified'} stat line.
            </div>
          </SectionCard>
        )}

        {selected && (
          <div className="grid lg:grid-cols-[340px_1fr] gap-4">
            {/* Selected player profile */}
            <div>
              <SectionCard title="Selected Player">
                <div className="flex items-center gap-3">
                  {selected.headshot_url
                    ? <img src={selected.headshot_url} alt="" className="w-14 h-14 rounded-full object-cover" style={{ border: `2px solid ${T.gold}` }} />
                    : <div className="w-14 h-14 rounded-full flex items-center justify-center text-white font-bold" style={{ background: T.accent }}>
                        {(selected.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('')}
                      </div>}
                  <div className="min-w-0">
                    <Link to={`/player/${selected.id}`} className="text-[16px] font-bold hover:underline truncate block" style={{ color: T.text }}>{selected.name}</Link>
                    <div className="text-[11.5px]" style={{ color: T.textMuted }}>
                      {selected.team}{selected.level ? ` · ${selected.level}` : ''}{(side === 'pitcher' && selected.role) ? ` · ${selected.role}` : (selected.position ? ` · ${selected.position}` : '')}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: T.textLight }}>
                      {Math.round(selected.sample)} {side === 'hitter' ? 'PA' : 'IP'}
                      {!selected.qualified && <span className="ml-1" style={{ color: T.hot }}>· small sample</span>}
                    </div>
                  </div>
                </div>

                {arche && (
                  <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${T.border}` }}>
                    <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Archetype</div>
                    <div className="text-[15px] font-extrabold" style={{ color: T.gold }}>{arche.title}</div>
                    <p className="text-[11.5px] mt-0.5 leading-snug" style={{ color: T.textMuted }}>{arche.description}</p>
                    {radarStats.length > 0 && <div className="mt-1"><RadarChart stats={radarStats} /></div>}
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(arche.tags || []).map(tg => (
                        <span key={tg} className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: T.track, color: T.textMuted }}>{tg}</span>
                      ))}
                    </div>
                  </div>
                )}

                {config && selected.percentiles && (
                  <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${T.border}` }}>
                    <div className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: T.textLight }}>
                      Profile vs NW {side}s
                    </div>
                    {config.metrics.map(m => (
                      <PctRow key={m.key} stat={m.label}
                        pct={Math.round(selected.percentiles[m.key] ?? 0)}
                        raw={fmtMetric(m.format, selected.metrics?.[m.key])} />
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>

            {/* Results */}
            <div>
              <SectionCard title="Top 5 Comparables"
                right={pool === 'nw' ? 'NW DATABASE' : 'RECENT MLB SEASONS'}>
                {!selected.qualified && (
                  <div className="mb-3 px-3 py-2 rounded text-[11.5px]" style={{ background: T.highlight, color: T.text, border: `1px solid ${T.borderStrong}` }}>
                    Small-sample warning: this player is below the {config?.thresholdLabel} qualifier, so these comps
                    are less stable. Reliability is flagged on each result.
                  </div>
                )}
                <div className="flex flex-col gap-3">
                  {results.map((r, i) => (
                    <CompCard key={r.id} rank={i + 1} result={r} side={side} pool={pool} selected={selected} />
                  ))}
                  {results.length === 0 && (
                    <div className="text-center py-8 text-[13px]" style={{ color: T.textMuted }}>
                      No comparables match these filters. Try loosening the match settings.
                    </div>
                  )}
                </div>
                <p className="text-[10.5px] mt-3 leading-snug" style={{ color: T.textLight }}>
                  Similarity is a weighted percentile-profile distance scored 0 to 100. It describes statistical
                  shape, not a projection, scouting grade, or future-performance forecast.
                </p>
              </SectionCard>
            </div>
          </div>
        )}
      </div>
    </ProfileShell>
  )
}
