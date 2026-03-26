import { useState, useRef, useEffect, useCallback, forwardRef } from 'react'
import { useApi, useDivisions } from '../hooks/useApi'

// ─── Size presets ───
const SIZE_PRESETS = [
  { label: 'Instagram Post', w: 1080, h: 1080 },
  { label: 'IG Story / Reels', w: 1080, h: 1920 },
  { label: 'Twitter / X', w: 1200, h: 675 },
]

// ─── Stat presets for quick access ───
const STAT_PRESETS = {
  batting: [
    { key: 'wrc_plus',     label: 'wRC+',   sort: 'wrc_plus',     dir: 'desc', format: 'int',  title: 'wRC+ Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'woba', label: 'wOBA', format: 'avg' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
      ] },
    { key: 'batting_avg',  label: 'AVG',    sort: 'batting_avg',  dir: 'desc', format: 'avg',  title: 'Batting Avg Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'hits', label: 'H', format: 'int' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'home_runs',    label: 'HR',     sort: 'home_runs',    dir: 'desc', format: 'int',  title: 'Home Run Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'iso', label: 'ISO', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'rbi', label: 'RBI', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'stolen_bases',  label: 'SB',    sort: 'stolen_bases', dir: 'desc', format: 'int',  title: 'Stolen Base Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'runs', label: 'R', format: 'int' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'woba',          label: 'wOBA',  sort: 'woba',         dir: 'desc', format: 'avg',  title: 'wOBA Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
      ] },
    { key: 'offensive_war', label: 'oWAR',  sort: 'offensive_war', dir: 'desc', format: 'war', title: 'Offensive WAR Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'woba', label: 'wOBA', format: 'avg' },
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'home_runs', label: 'HR', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
  ],
  pitching: [
    { key: 'fip_plus',     label: 'FIP+',   sort: 'fip_plus',     dir: 'desc', format: 'int',  title: 'FIP+ Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'era',           label: 'ERA',    sort: 'era',          dir: 'asc',  format: 'era',  title: 'ERA Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'era_plus',      label: 'ERA+',   sort: 'era_plus',     dir: 'desc', format: 'int',  title: 'ERA+ Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'strikeouts',    label: 'K',      sort: 'strikeouts',   dir: 'desc', format: 'int',  title: 'Strikeout Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'siera', label: 'SIERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'pitching_war',  label: 'pWAR',   sort: 'pitching_war', dir: 'desc', format: 'war',  title: 'Pitching WAR Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'fip',           label: 'FIP',    sort: 'fip',          dir: 'asc',  format: 'era',  title: 'FIP Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'siera', label: 'SIERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
  ],
  war: [
    { key: 'total_war',    label: 'WAR',    sort: 'total_war',    dir: 'desc', format: 'war',  title: 'WAR Leaders', endpoint: '/leaderboards/war',
      extra: [
        { key: 'offensive_war', label: 'oWAR', format: 'war' },
        { key: 'pitching_war', label: 'pWAR', format: 'war' },
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'era', label: 'ERA', format: 'era' },
      ] },
  ],
}

// ─── Format helpers ───
function fmt(val, format) {
  if (val == null || val === '') return '—'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip':  return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}

// ─── Load html2canvas from CDN ───
let html2canvasPromise = null
function loadHtml2Canvas() {
  if (html2canvasPromise) return html2canvasPromise
  html2canvasPromise = new Promise((resolve, reject) => {
    if (window.html2canvas) { resolve(window.html2canvas); return }
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
    script.onload = () => resolve(window.html2canvas)
    script.onerror = () => reject(new Error('Failed to load html2canvas'))
    document.head.appendChild(script)
  })
  return html2canvasPromise
}

// ─── The main component ───
export default function SocialGraphics() {
  const cardRef = useRef(null)

  // ─── State ───
  const [category, setCategory] = useState('pitching')
  const [presetIdx, setPresetIdx] = useState(0)
  const [sizeIdx, setSizeIdx] = useState(0)
  const [count, setCount] = useState(10)
  const [season, setSeason] = useState(2026)
  const [divisionId, setDivisionId] = useState(null)
  const [yearFilter, setYearFilter] = useState('')
  const [minQual, setMinQual] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [exporting, setExporting] = useState(false)

  const { data: divisions } = useDivisions()
  const preset = STAT_PRESETS[category][presetIdx]
  const size = SIZE_PRESETS[sizeIdx]

  // Reset preset index when switching categories
  useEffect(() => { setPresetIdx(0) }, [category])

  // Build API params
  const apiParams = {
    season,
    sort_by: preset.sort,
    sort_dir: preset.dir,
    limit: count,
    ...(divisionId && { division_id: divisionId }),
    ...(yearFilter && { year_in_school: yearFilter }),
  }
  if (preset.endpoint.includes('batting')) {
    apiParams.min_pa = minQual || 50
  } else if (preset.endpoint.includes('pitching')) {
    apiParams.min_ip = minQual || 20
  } else {
    apiParams.min_pa = minQual || 30
    apiParams.min_ip = minQual || 10
  }

  const { data: rawData, loading } = useApi(preset.endpoint, apiParams, [
    season, preset.sort, preset.dir, count, divisionId, yearFilter, minQual, preset.endpoint
  ])

  const players = Array.isArray(rawData) ? rawData : rawData?.data || []

  const divLabel = divisionId
    ? (divisions || []).find(d => d.id === Number(divisionId))?.name || ''
    : 'PNW'
  const titleText = customTitle || `Top ${count} ${divLabel} ${preset.title}`
  const subtitle = `${season} Season${yearFilter ? ` • ${yearFilter} Only` : ''}`

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!cardRef.current) return
    setExporting(true)
    try {
      const html2canvas = await loadHtml2Canvas()
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        backgroundColor: null,
        useCORS: true,
        logging: false,
        width: size.w,
        height: size.h,
      })
      const link = document.createElement('a')
      link.download = `nwbb-${preset.key}-top${count}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed — check console for details')
    } finally {
      setExporting(false)
    }
  }, [size, preset, count, season])

  const isVertical = size.h > size.w
  const isTall = size.h / size.w > 1.5
  const scale = Math.min(600 / size.w, 800 / size.h)

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Social Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">
        Create shareable leaderboard images optimized for social media.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-72 shrink-0 space-y-4">
          {/* Category */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Category</label>
            <div className="flex gap-1">
              {['batting', 'pitching', 'war'].map(c => (
                <button key={c} onClick={() => setCategory(c)}
                  className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                    ${category === c ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{c === 'war' ? 'WAR' : c.charAt(0).toUpperCase() + c.slice(1)}</button>
              ))}
            </div>

            <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Stat</label>
            <div className="flex flex-wrap gap-1">
              {STAT_PRESETS[category].map((p, i) => (
                <button key={p.key} onClick={() => setPresetIdx(i)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-all
                    ${presetIdx === i ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{p.label}</button>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</label>

            <div>
              <label className="text-xs text-gray-500">Season</label>
              <select value={season} onChange={e => setSeason(+e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                {[2026, 2025, 2024].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500">Division</label>
              <select value={divisionId || ''} onChange={e => setDivisionId(e.target.value || null)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                <option value="">All Divisions</option>
                {(divisions || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500">Class Year</label>
              <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                <option value="">All</option>
                {['Fr', 'So', 'Jr', 'Sr'].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-gray-500">Min {preset.endpoint.includes('batting') ? 'PA' : 'IP'}</label>
                <input type="number" value={minQual} onChange={e => setMinQual(e.target.value)}
                  placeholder={preset.endpoint.includes('batting') ? '50' : '20'}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-500"># Players</label>
                <select value={count} onChange={e => setCount(+e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  {[5, 10, 15, 20].map(n => <option key={n} value={n}>Top {n}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Size + Export */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Export</label>

            <div>
              <label className="text-xs text-gray-500">Size</label>
              <div className="flex flex-col gap-1 mt-1">
                {SIZE_PRESETS.map((s, i) => (
                  <button key={s.label} onClick={() => setSizeIdx(i)}
                    className={`px-3 py-1.5 text-xs rounded text-left transition-all
                      ${sizeIdx === i ? 'bg-nw-teal text-white shadow font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >{s.label} <span className="opacity-60">({s.w}×{s.h})</span></button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500">Custom Title (optional)</label>
              <input type="text" value={customTitle} onChange={e => setCustomTitle(e.target.value)}
                placeholder={titleText} maxLength={60}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
            </div>

            <button
              onClick={handleExport}
              disabled={exporting || loading || !players.length}
              className="w-full py-2.5 rounded-lg bg-nw-teal text-white font-bold text-sm
                hover:bg-nw-teal-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {exporting ? (
                <><Spinner /> Exporting...</>
              ) : (
                <><DownloadIcon /> Download PNG</>
              )}
            </button>
          </div>
        </div>

        {/* ═══ RIGHT: Card Preview ═══ */}
        <div className="flex-1 flex flex-col items-center">
          <div className="text-xs text-gray-400 mb-2">Preview ({size.w}×{size.h})</div>

          <div style={{
            width: size.w * scale,
            height: size.h * scale,
            overflow: 'hidden',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}>
            <div style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: size.w,
              height: size.h,
            }}>
              <LeaderCard
                ref={cardRef}
                players={players}
                preset={preset}
                title={titleText}
                subtitle={subtitle}
                size={size}
                loading={loading}
                isVertical={isVertical}
                isTall={isTall}
                count={count}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// The exportable card component
// ═══════════════════════════════════════════════════════════

const LeaderCard = forwardRef(function LeaderCard(
  { players, preset, title, subtitle, size, loading, isVertical, isTall, count },
  ref
) {
  const w = size.w
  const h = size.h
  const isLandscape = w > h
  const extraCols = preset.extra || []

  // ─── Dynamic sizing: rows FILL the available space ───
  const headerH = isTall ? h * 0.10 : isLandscape ? h * 0.15 : h * 0.16
  const footerH = isLandscape ? 30 : isTall ? 36 : 40
  const bodyPadY = Math.floor(isLandscape ? 4 : isTall ? w * 0.015 : w * 0.015)
  const bodyH = h - headerH - footerH - bodyPadY * 2
  const colHeaderH = isLandscape ? 18 : 24
  const actualCount = Math.max(count, 1)
  const rowH = Math.floor((bodyH - colHeaderH) / actualCount)

  const fontSize = Math.min(Math.max(Math.floor(w / 55), 13), 22)
  const titleSize = isLandscape
    ? Math.min(Math.max(Math.floor(w / 30), 18), 34)
    : Math.min(Math.max(Math.floor(w / 24), 20), 42)
  const subtitleSize = Math.max(Math.floor(titleSize * 0.42), 10)
  const rankSize = Math.max(fontSize + 2, 16)

  // Logo size based on row height
  const logoSize = Math.min(Math.floor(rowH * 0.55), 32)

  // Column widths — main stat is wider, extras are narrower to fit 5 cols
  const mainStatW = Math.floor(w * 0.10)
  const extraW = Math.floor(w * 0.09)
  const rankW = Math.floor(w * 0.045)
  const logoW = logoSize + 8

  return (
    <div
      ref={ref}
      style={{
        width: w,
        height: h,
        background: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)',
        fontFamily: "'Inter', 'Helvetica Neue', system-ui, sans-serif",
        color: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Decorative elements */}
      <div style={{
        position: 'absolute', top: -120, right: -120,
        width: 400, height: 400,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,104,122,0.3) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: -80, left: -80,
        width: 300, height: 300,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,138,158,0.15) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* ─── Header ─── */}
      <div style={{
        height: headerH,
        padding: `${Math.floor(headerH * 0.12)}px ${Math.floor(w * 0.04)}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        borderBottom: '2px solid rgba(255,255,255,0.08)',
        position: 'relative',
        zIndex: 1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: isLandscape ? 5 : 8, marginBottom: isLandscape ? 1 : 4 }}>
          <img
            src="/images/nw-logo.png"
            alt=""
            style={{ width: Math.floor(titleSize * 0.8), height: Math.floor(titleSize * 0.8), borderRadius: 3 }}
            crossOrigin="anonymous"
          />
          <span style={{
            fontSize: Math.floor(titleSize * 0.35),
            fontWeight: 800,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.5)',
          }}>NWBB Stats</span>
        </div>
        <div style={{
          fontSize: titleSize,
          fontWeight: 900,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          background: 'linear-gradient(90deg, #ffffff 0%, #7dd3fc 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          {title}
        </div>
        <div style={{
          fontSize: subtitleSize,
          color: 'rgba(255,255,255,0.45)',
          fontWeight: 500,
          marginTop: 1,
          letterSpacing: '0.05em',
        }}>
          {subtitle}
        </div>
      </div>

      {/* ─── Body / Rows ─── */}
      <div style={{
        flex: 1,
        padding: `${bodyPadY}px ${Math.floor(w * 0.035)}px`,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Column header row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          height: colHeaderH,
          paddingLeft: rankW + logoW + 4,
          fontSize: Math.floor(fontSize * 0.6),
          fontWeight: 700,
          color: 'rgba(255,255,255,0.3)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}>
          <span style={{ flex: 1 }}>Player</span>
          <span style={{ width: mainStatW, textAlign: 'right' }}>{preset.label}</span>
          {extraCols.map(col => (
            <span key={col.key} style={{ width: extraW, textAlign: 'right' }}>{col.label}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4 }}>
            Loading...
          </div>
        ) : (
          players.slice(0, count).map((p, i) => {
            const name = p.first_name && p.last_name
              ? `${p.first_name} ${p.last_name}`
              : p.name || '—'
            const team = p.team_short || p.short_name || p.team_name || ''
            const level = p.division_level || ''
            const logoUrl = p.logo_url || ''
            const mainVal = p[preset.key] ?? p[preset.sort]
            const isTop3 = i < 3

            return (
              <div
                key={p.id || p.player_id || i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: rowH,
                  padding: `0 ${Math.floor(w * 0.01)}px`,
                  borderRadius: 6,
                  background: isTop3
                    ? `linear-gradient(90deg, rgba(0,138,158,${0.22 - i * 0.05}) 0%, rgba(0,104,122,0.04) 100%)`
                    : i % 2 === 0
                      ? 'rgba(255,255,255,0.025)'
                      : 'transparent',
                  borderLeft: isTop3 ? `3px solid rgba(125,211,252,${0.8 - i * 0.2})` : '3px solid transparent',
                }}
              >
                {/* Rank */}
                <span style={{
                  width: rankW,
                  fontSize: rankSize,
                  fontWeight: 900,
                  color: isTop3 ? '#7dd3fc' : 'rgba(255,255,255,0.25)',
                  fontFeatureSettings: '"tnum"',
                  textAlign: 'center',
                }}>
                  {i + 1}
                </span>

                {/* Team logo */}
                <div style={{
                  width: logoW,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt=""
                      style={{
                        width: logoSize,
                        height: logoSize,
                        objectFit: 'contain',
                        borderRadius: 2,
                        opacity: 0.9,
                      }}
                      crossOrigin="anonymous"
                    />
                  ) : (
                    <div style={{
                      width: logoSize,
                      height: logoSize,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.08)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: Math.floor(logoSize * 0.35),
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.3)',
                    }}>
                      {team.slice(0, 3)}
                    </div>
                  )}
                </div>

                {/* Player info */}
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', paddingLeft: 4 }}>
                  <div style={{
                    fontSize: fontSize,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: 1.15,
                  }}>
                    {name}
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    marginTop: 1,
                  }}>
                    <span style={{
                      fontSize: Math.floor(fontSize * 0.68),
                      color: 'rgba(255,255,255,0.45)',
                      fontWeight: 500,
                    }}>
                      {team}
                    </span>
                    {level && (
                      <span style={{
                        fontSize: Math.floor(fontSize * 0.55),
                        fontWeight: 600,
                        color: 'rgba(255,255,255,0.25)',
                        letterSpacing: '0.04em',
                      }}>
                        {level}
                      </span>
                    )}
                  </div>
                </div>

                {/* Main stat (big) */}
                <div style={{
                  width: mainStatW,
                  textAlign: 'right',
                  fontSize: Math.floor(fontSize * 1.25),
                  fontWeight: 900,
                  fontFeatureSettings: '"tnum"',
                  color: isTop3 ? '#7dd3fc' : '#e0f2fe',
                  textShadow: isTop3 ? '0 0 20px rgba(125,211,252,0.3)' : 'none',
                }}>
                  {fmt(mainVal, preset.format)}
                </div>

                {/* Extra stat columns */}
                {extraCols.map(col => (
                  <div key={col.key} style={{
                    width: extraW,
                    textAlign: 'right',
                    fontSize: Math.floor(fontSize * 0.75),
                    fontWeight: 500,
                    color: 'rgba(255,255,255,0.45)',
                    fontFeatureSettings: '"tnum"',
                  }}>
                    {fmt(p[col.key], col.format)}
                  </div>
                ))}
              </div>
            )
          })
        )}
      </div>

      {/* ─── Footer ─── */}
      <div style={{
        height: footerH,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `0 ${Math.floor(w * 0.04)}px`,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        position: 'relative',
        zIndex: 1,
      }}>
        <span style={{
          fontSize: Math.floor(fontSize * 0.58),
          color: 'rgba(255,255,255,0.25)',
          fontWeight: 500,
        }}>
          nwbaseballstats.com
        </span>
        <span style={{
          fontSize: Math.floor(fontSize * 0.52),
          color: 'rgba(255,255,255,0.18)',
          fontWeight: 400,
        }}>
          Min {preset.endpoint.includes('batting') ? '50 PA' : '20 IP'}
        </span>
      </div>
    </div>
  )
})

// ─── Tiny icons ───
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2v8M4 7l4 4 4-4M3 13h10" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
      <circle cx="8" cy="8" r="6" opacity="0.3" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  )
}
