import { useState, useRef, useEffect, useCallback, forwardRef } from 'react'
import { useApi, useDivisions } from '../hooks/useApi'

// ─── Size presets ───
const SIZE_PRESETS = [
  { label: 'Instagram Post', w: 1080, h: 1080 },
  { label: 'IG Story / Reels', w: 1080, h: 1920 },
  { label: 'Twitter / X', w: 1200, h: 675 },
]

// ─── Card theme ───
const THEME = {
  bg: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)',
  accent: '#7dd3fc',
  accentGlow: 'rgba(125,211,252,0.3)',
  highlight: 'rgba(0,138,158,',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.45)',
  textMuted: 'rgba(255,255,255,0.25)',
  border: 'rgba(255,255,255,0.08)',
  rowAlt: 'rgba(255,255,255,0.025)',
  orb1: 'rgba(0,104,122,0.3)',
  orb2: 'rgba(0,138,158,0.15)',
}

// ─── All available stats with metadata ───
const ALL_BATTING_STATS = [
  { key: 'wrc_plus',     label: 'wRC+',   format: 'int',  dir: 'desc' },
  { key: 'batting_avg',  label: 'AVG',    format: 'avg',  dir: 'desc' },
  { key: 'home_runs',    label: 'HR',     format: 'int',  dir: 'desc' },
  { key: 'stolen_bases', label: 'SB',     format: 'int',  dir: 'desc' },
  { key: 'woba',         label: 'wOBA',   format: 'avg',  dir: 'desc' },
  { key: 'offensive_war',label: 'oWAR',   format: 'war',  dir: 'desc' },
  { key: 'on_base_pct',  label: 'OBP',    format: 'avg',  dir: 'desc' },
  { key: 'slugging_pct', label: 'SLG',    format: 'avg',  dir: 'desc' },
  { key: 'ops',          label: 'OPS',    format: 'avg',  dir: 'desc' },
  { key: 'iso',          label: 'ISO',    format: 'avg',  dir: 'desc' },
  { key: 'hits',         label: 'H',      format: 'int',  dir: 'desc' },
  { key: 'runs',         label: 'R',      format: 'int',  dir: 'desc' },
  { key: 'rbi',          label: 'RBI',    format: 'int',  dir: 'desc' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct',  dir: 'desc' },
  { key: 'k_pct',        label: 'K%',     format: 'pct',  dir: 'asc'  },
  { key: 'plate_appearances', label: 'PA', format: 'int', dir: 'desc' },
]

const ALL_PITCHING_STATS = [
  { key: 'fip_plus',     label: 'FIP+',   format: 'int',  dir: 'desc' },
  { key: 'era',          label: 'ERA',    format: 'era',  dir: 'asc'  },
  { key: 'era_plus',     label: 'ERA+',   format: 'int',  dir: 'desc' },
  { key: 'strikeouts',   label: 'K',      format: 'int',  dir: 'desc' },
  { key: 'pitching_war', label: 'pWAR',   format: 'war',  dir: 'desc' },
  { key: 'fip',          label: 'FIP',    format: 'era',  dir: 'asc'  },
  { key: 'whip',         label: 'WHIP',   format: 'era',  dir: 'asc'  },
  { key: 'k_pct',        label: 'K%',     format: 'pct',  dir: 'desc' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct',  dir: 'asc'  },
  { key: 'xfip',         label: 'xFIP',   format: 'era',  dir: 'asc'  },
  { key: 'siera',        label: 'SIERA',  format: 'era',  dir: 'asc'  },
  { key: 'innings_pitched', label: 'IP',  format: 'ip',   dir: 'desc' },
]

const ALL_TEAM_BATTING_STATS = [
  { key: 'total_hr',      label: 'HR',     format: 'int',  dir: 'desc' },
  { key: 'team_avg',      label: 'AVG',    format: 'avg',  dir: 'desc' },
  { key: 'total_runs',    label: 'R',      format: 'int',  dir: 'desc' },
  { key: 'total_rbi',     label: 'RBI',    format: 'int',  dir: 'desc' },
  { key: 'total_sb',      label: 'SB',     format: 'int',  dir: 'desc' },
  { key: 'total_hits',    label: 'H',      format: 'int',  dir: 'desc' },
  { key: 'team_obp',      label: 'OBP',    format: 'avg',  dir: 'desc' },
  { key: 'team_slg',      label: 'SLG',    format: 'avg',  dir: 'desc' },
  { key: 'team_ops',      label: 'OPS',    format: 'avg',  dir: 'desc' },
  { key: 'avg_woba',      label: 'wOBA',   format: 'avg',  dir: 'desc' },
  { key: 'avg_wrc_plus',  label: 'wRC+',   format: 'int',  dir: 'desc' },
  { key: 'avg_iso',       label: 'ISO',    format: 'avg',  dir: 'desc' },
  { key: 'total_owar',    label: 'oWAR',   format: 'war',  dir: 'desc' },
]

const ALL_TEAM_PITCHING_STATS = [
  { key: 'team_era',      label: 'ERA',    format: 'era',  dir: 'asc'  },
  { key: 'team_whip',     label: 'WHIP',   format: 'era',  dir: 'asc'  },
  { key: 'avg_fip',       label: 'FIP',    format: 'era',  dir: 'asc'  },
  { key: 'avg_fip_plus',  label: 'FIP+',   format: 'int',  dir: 'desc' },
  { key: 'avg_era_plus',  label: 'ERA+',   format: 'int',  dir: 'desc' },
  { key: 'avg_xfip',      label: 'xFIP',   format: 'era',  dir: 'asc'  },
  { key: 'total_k',       label: 'K',      format: 'int',  dir: 'desc' },
  { key: 'total_pwar',    label: 'pWAR',   format: 'war',  dir: 'desc' },
  { key: 'total_ip',      label: 'IP',     format: 'ip',   dir: 'desc' },
  { key: 'pitching_k_pct',  label: 'K%',   format: 'pct',  dir: 'desc' },
  { key: 'pitching_bb_pct', label: 'BB%',  format: 'pct',  dir: 'asc'  },
]

const ALL_TEAM_COMBINED_STATS = [
  { key: 'total_war',     label: 'WAR',    format: 'war',  dir: 'desc' },
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
  teams: [
    { key: 'total_hr',     label: 'HR',     sort: 'total_hr',     dir: 'desc', format: 'int',  title: 'Team HR Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'avg_iso', label: 'ISO', format: 'avg' },
      ] },
    { key: 'team_avg',     label: 'AVG',    sort: 'team_avg',     dir: 'desc', format: 'avg',  title: 'Team AVG Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'total_hits', label: 'H', format: 'int' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
      ] },
    { key: 'team_era',     label: 'ERA',    sort: 'team_era',     dir: 'asc',  format: 'era',  title: 'Team ERA Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_whip', label: 'WHIP', format: 'era' },
        { key: 'avg_fip', label: 'FIP', format: 'era' },
        { key: 'total_k', label: 'K', format: 'int' },
        { key: 'total_ip', label: 'IP', format: 'ip' },
      ] },
    { key: 'total_war',    label: 'WAR',    sort: 'total_war',    dir: 'desc', format: 'war',  title: 'Team WAR Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'total_owar', label: 'oWAR', format: 'war' },
        { key: 'total_pwar', label: 'pWAR', format: 'war' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'team_era', label: 'ERA', format: 'era' },
      ] },
    { key: 'total_runs',   label: 'R',      sort: 'total_runs',   dir: 'desc', format: 'int',  title: 'Team Runs Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_avg', label: 'AVG', format: 'avg' },
        { key: 'total_hr', label: 'HR', format: 'int' },
        { key: 'total_rbi', label: 'RBI', format: 'int' },
        { key: 'team_obp', label: 'OBP', format: 'avg' },
      ] },
    { key: 'total_sb',     label: 'SB',     sort: 'total_sb',     dir: 'desc', format: 'int',  title: 'Team SB Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_avg', label: 'AVG', format: 'avg' },
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
      ] },
  ],
}

// ─── Format helpers ───
function fmt(val, format) {
  if (val == null || val === '') return '-'
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

// ─── Canvas Export Helpers ───
async function loadExportImage(src) {
  if (!src) return null
  // For external URLs, route through our proxy to avoid CORS issues
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal
    ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}`
    : src.startsWith('/') ? src : src
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const objectUrl = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { resolve(img); URL.revokeObjectURL(objectUrl) }
      img.onerror = () => { resolve(null); URL.revokeObjectURL(objectUrl) }
      img.src = objectUrl
    })
  } catch {
    return null
  }
}

function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
}

function canvasRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function truncText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

// ─── Helper: get available stats list for custom picker ───
function getAvailableStats(category) {
  if (category === 'batting') return ALL_BATTING_STATS
  if (category === 'pitching') return ALL_PITCHING_STATS
  if (category === 'teams') return [...ALL_TEAM_BATTING_STATS, ...ALL_TEAM_PITCHING_STATS, ...ALL_TEAM_COMBINED_STATS]
  return [] // war uses fixed preset
}

// ─── The main component ───
export default function SocialGraphics() {
  const cardRef = useRef(null)

  // ─── State ───
  const [category, setCategory] = useState('batting')
  const [presetIdx, setPresetIdx] = useState(0)
  const [sizeIdx, setSizeIdx] = useState(0)
  const [count, setCount] = useState(10)
  const [season, setSeason] = useState(2026)
  const [divisionId, setDivisionId] = useState(null)
  const [yearFilter, setYearFilter] = useState('')
  const [minQual, setMinQual] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [exporting, setExporting] = useState(false)
  const [qualified, setQualified] = useState(true)
  const [mode, setMode] = useState('preset') // 'preset' or 'custom'

  // Custom stat picker state
  const [customMainStat, setCustomMainStat] = useState('')
  const [customExtraCols, setCustomExtraCols] = useState([])

  const { data: divisions } = useDivisions()
  const preset = STAT_PRESETS[category]?.[presetIdx] || STAT_PRESETS[category]?.[0]
  const size = SIZE_PRESETS[sizeIdx]
  const theme = THEME

  // Reset preset index when switching categories
  useEffect(() => {
    setPresetIdx(0)
    setCustomMainStat('')
    setCustomExtraCols([])
    setMode('preset')
  }, [category])

  // ─── Build the active stat config (preset or custom) ───
  const activeConfig = (() => {
    if (mode === 'custom' && customMainStat) {
      const allStats = getAvailableStats(category)
      const mainDef = allStats.find(s => s.key === customMainStat)
      if (!mainDef) return preset
      const endpoint = category === 'teams' ? '/leaderboards/teams'
        : category === 'batting' ? '/leaderboards/batting'
        : category === 'pitching' ? '/leaderboards/pitching'
        : '/leaderboards/war'
      return {
        key: mainDef.key,
        label: mainDef.label,
        sort: mainDef.key,
        dir: mainDef.dir,
        format: mainDef.format,
        title: `${mainDef.label} Leaders`,
        endpoint,
        extra: customExtraCols.map(k => {
          const def = allStats.find(s => s.key === k)
          return def ? { key: def.key, label: def.label, format: def.format } : null
        }).filter(Boolean),
      }
    }
    return preset
  })()

  // Build API params
  const apiParams = {
    season,
    sort_by: activeConfig.sort,
    sort_dir: activeConfig.dir,
    limit: count,
    ...(divisionId && { division_id: divisionId }),
    ...(yearFilter && category !== 'teams' && { year_in_school: yearFilter }),
  }

  if (category === 'teams') {
    // team endpoint has no min_pa/min_ip or qualified toggle
  } else if (activeConfig.endpoint.includes('batting')) {
    if (qualified) {
      apiParams.qualified = true
    } else {
      apiParams.min_pa = minQual || 1
    }
  } else if (activeConfig.endpoint.includes('pitching')) {
    if (qualified) {
      apiParams.qualified = true
    } else {
      apiParams.min_ip = minQual || 1
    }
  } else {
    // WAR
    if (qualified) {
      apiParams.qualified = true
    } else {
      apiParams.min_pa = minQual || 1
      apiParams.min_ip = minQual || 1
    }
  }

  const { data: rawData, loading } = useApi(activeConfig.endpoint, apiParams, [
    season, activeConfig.sort, activeConfig.dir, count, divisionId, yearFilter, minQual, activeConfig.endpoint, qualified
  ])

  const items = Array.isArray(rawData) ? rawData : rawData?.data || []
  const isTeamMode = category === 'teams'

  const divLabel = divisionId
    ? (divisions || []).find(d => d.id === Number(divisionId))?.name || ''
    : 'PNW'
  const titleText = customTitle || `Top ${count} ${divLabel} ${activeConfig.title}`
  const subtitle = `${season} Season${yearFilter && !isTeamMode ? ` • ${yearFilter} Only` : ''}${!qualified && !isTeamMode ? ' • Unqualified' : ''}`

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!items.length) return
    setExporting(true)
    try {
      const dpr = 2
      const w = size.w, h = size.h
      const isLandscapeLocal = w > h
      const isTallLocal = h / w > 1.5
      const config = activeConfig
      const extraCols = config.extra || []

      // Layout calculations (matching LeaderCard exactly)
      const headerH = isTallLocal ? h * 0.10 : isLandscapeLocal ? h * 0.15 : h * 0.16
      const footerH = isLandscapeLocal ? 30 : isTallLocal ? 36 : 40
      const bodyPadY = Math.floor(isLandscapeLocal ? 4 : isTallLocal ? w * 0.015 : w * 0.015)
      const bodyH = h - headerH - footerH - bodyPadY * 2
      const colHeaderH = isLandscapeLocal ? 18 : 24
      const actualCount = Math.max(count, 1)
      const rowH = Math.floor((bodyH - colHeaderH) / actualCount)
      const fontSize = Math.min(Math.max(Math.floor(w / 55), 13), 22)
      const titleSize = isLandscapeLocal
        ? Math.min(Math.max(Math.floor(w / 30), 18), 34)
        : Math.min(Math.max(Math.floor(w / 24), 20), 42)
      const subtitleSz = Math.max(Math.floor(titleSize * 0.42), 10)
      const rankSize = Math.max(fontSize + 2, 16)
      const logoSize = Math.min(Math.floor(rowH * 0.55), 32)
      const mainStatW = Math.floor(w * 0.10)
      const extraW = Math.floor(w * 0.09)
      const rankW = Math.floor(w * 0.045)
      const logoW = logoSize + 8
      const recordW = isTeamMode ? Math.floor(w * 0.08) : 0
      const bodyPadX = Math.floor(w * 0.035)
      const rowPadX = Math.floor(w * 0.01)
      const headerPadX = Math.floor(w * 0.04)
      const font = 'Inter, Helvetica Neue, sans-serif'

      // Pre-load all images in parallel
      const [faviconImg, ...logoImgs] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...items.slice(0, count).map(p => loadExportImage(p.logo_url))
      ])

      // Create canvas
      const canvas = document.createElement('canvas')
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      // ─── Background gradient ───
      // CSS: linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)
      const ang = 160 * Math.PI / 180
      const sinA = Math.sin(ang), cosA = Math.cos(ang)
      const halfDiag = (Math.abs(w * sinA) + Math.abs(h * cosA)) / 2
      const cxG = w / 2, cyG = h / 2
      const grad = ctx.createLinearGradient(
        cxG - halfDiag * sinA, cyG + halfDiag * cosA,
        cxG + halfDiag * sinA, cyG - halfDiag * cosA
      )
      grad.addColorStop(0, '#0a1628')
      grad.addColorStop(0.35, '#0f2744')
      grad.addColorStop(1, '#00687a')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // ─── Decorative orbs ───
      const orb1 = ctx.createRadialGradient(w - 80, 80, 0, w - 80, 80, 200)
      orb1.addColorStop(0, 'rgba(0,104,122,0.3)')
      orb1.addColorStop(0.7, 'rgba(0,104,122,0)')
      orb1.addColorStop(1, 'rgba(0,104,122,0)')
      ctx.fillStyle = orb1
      ctx.fillRect(0, 0, w, h)

      const orb2 = ctx.createRadialGradient(70, h - 70, 0, 70, h - 70, 150)
      orb2.addColorStop(0, 'rgba(0,138,158,0.15)')
      orb2.addColorStop(0.7, 'rgba(0,138,158,0)')
      orb2.addColorStop(1, 'rgba(0,138,158,0)')
      ctx.fillStyle = orb2
      ctx.fillRect(0, 0, w, h)

      // ─── Header ───
      const headerPadTop = Math.floor(headerH * 0.12)
      let curY = headerPadTop

      // NW logo + "NWBB STATS"
      const nwLogoSz = Math.floor(titleSize * 0.8)
      if (faviconImg) {
        drawImageContain(ctx, faviconImg, headerPadX, curY, nwLogoSz, nwLogoSz)
      }
      // Draw "NWBB STATS" with manual letter spacing
      const nwbbText = 'NWBB STATS'
      const nwbbFontSize = Math.floor(titleSize * 0.35)
      ctx.font = `800 ${nwbbFontSize}px ${font}`
      ctx.fillStyle = theme.textSecondary
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const nwbbX = headerPadX + nwLogoSz + (isLandscapeLocal ? 5 : 8)
      const nwbbSpacing = nwbbFontSize * 0.15
      let charX = nwbbX
      for (const ch of nwbbText) {
        ctx.fillText(ch, charX, curY + nwLogoSz / 2)
        charX += ctx.measureText(ch).width + nwbbSpacing
      }

      curY += nwLogoSz + (isLandscapeLocal ? 2 : 6)

      // Title
      ctx.font = `900 ${titleSize}px ${font}`
      ctx.fillStyle = '#ffffff'
      ctx.textBaseline = 'top'
      ctx.shadowColor = 'rgba(125,211,252,0.3)'
      ctx.shadowBlur = 40
      ctx.fillText(titleText, headerPadX, curY)
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'

      curY += titleSize * 1.4 + 2

      // Subtitle
      ctx.font = `500 ${subtitleSz}px ${font}`
      ctx.fillStyle = theme.textSecondary
      ctx.textBaseline = 'top'
      ctx.fillText(subtitle, headerPadX, curY)

      // Header bottom border
      ctx.strokeStyle = theme.border
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, headerH)
      ctx.lineTo(w, headerH)
      ctx.stroke()

      // ─── Column header row ───
      const bodyStartY = headerH + bodyPadY
      const colLeftPad = bodyPadX + rowPadX + 3 + rankW + logoW + 4

      ctx.font = `700 ${Math.floor(fontSize * 0.6)}px ${font}`
      ctx.fillStyle = theme.textMuted
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(isTeamMode ? 'TEAM' : 'PLAYER', colLeftPad, bodyStartY + colHeaderH / 2)

      // Stat headers from right
      let hdrX = w - bodyPadX - rowPadX
      for (let ei = extraCols.length - 1; ei >= 0; ei--) {
        ctx.textAlign = 'right'
        ctx.fillText(extraCols[ei].label, hdrX, bodyStartY + colHeaderH / 2)
        hdrX -= extraW
      }
      ctx.textAlign = 'right'
      ctx.fillText(config.label, hdrX, bodyStartY + colHeaderH / 2)
      hdrX -= mainStatW
      if (isTeamMode) {
        ctx.fillText('RECORD', hdrX, bodyStartY + colHeaderH / 2)
      }

      // ─── Data rows ───
      const rowStartY = bodyStartY + colHeaderH

      for (let i = 0; i < Math.min(count, items.length); i++) {
        const p = items[i]
        const name = isTeamMode
          ? (p.short_name || p.name || '-')
          : (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name || '-')
        const teamName = isTeamMode
          ? (p.conference_abbrev || '')
          : (p.team_short || p.short_name || p.team_name || '')
        const level = p.division_level || ''
        const mainVal = p[config.key] ?? p[config.sort]
        const isTop3 = i < 3

        const rowY = rowStartY + i * rowH
        const rowLeft = bodyPadX
        const rowWidth = w - bodyPadX * 2

        // Row background
        if (isTop3) {
          const opacity = (0.22 - i * 0.05)
          ctx.fillStyle = `rgba(0,138,158,${opacity})`
          canvasRoundRect(ctx, rowLeft, rowY, rowWidth, rowH, 6)
          ctx.fill()
          // Left accent bar
          ctx.fillStyle = '#7dd3fc'
          ctx.fillRect(rowLeft, rowY + 2, 3, rowH - 4)
        } else if (i % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)'
          canvasRoundRect(ctx, rowLeft, rowY, rowWidth, rowH, 6)
          ctx.fill()
        }

        let cellX = rowLeft + rowPadX + 3
        const cellCY = rowY + rowH / 2

        // Rank
        ctx.font = `900 ${rankSize}px ${font}`
        ctx.fillStyle = isTop3 ? '#7dd3fc' : theme.textMuted
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i + 1), cellX + rankW / 2, cellCY)
        cellX += rankW

        // Logo
        const logoImg = logoImgs[i]
        if (logoImg) {
          drawImageContain(ctx, logoImg, cellX + 4, cellCY - logoSize / 2, logoSize, logoSize)
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          canvasRoundRect(ctx, cellX + 4, cellCY - logoSize / 2, logoSize, logoSize, 4)
          ctx.fill()
          ctx.font = `700 ${Math.floor(logoSize * 0.35)}px ${font}`
          ctx.fillStyle = theme.textMuted
          ctx.textAlign = 'center'
          ctx.fillText((isTeamMode ? (p.short_name || p.name) : teamName).slice(0, 3), cellX + 4 + logoSize / 2, cellCY)
        }
        cellX += logoW

        // Name + team/level
        const nameX = cellX + 4
        const statsEndX = w - bodyPadX - rowPadX
        const nameMaxW = statsEndX - extraCols.length * extraW - mainStatW - recordW - nameX - 12

        // Player name — position both lines relative to center
        const subFontSize = Math.floor(fontSize * 0.68)
        const lineGap = Math.floor(fontSize * 0.15)
        const totalTextH = fontSize + subFontSize + lineGap
        const nameY = cellCY - totalTextH / 2 + fontSize / 2
        const teamY = nameY + fontSize / 2 + lineGap + subFontSize / 2

        ctx.font = `700 ${fontSize}px ${font}`
        ctx.fillStyle = '#ffffff'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(truncText(ctx, name, nameMaxW), nameX, nameY)

        // Team + division level
        ctx.font = `500 ${subFontSize}px ${font}`
        ctx.fillStyle = theme.textSecondary
        ctx.fillText(teamName, nameX, teamY)
        if (level) {
          const tw = ctx.measureText(teamName).width
          ctx.font = `600 ${Math.floor(fontSize * 0.55)}px ${font}`
          ctx.fillStyle = theme.textMuted
          ctx.fillText(level, nameX + tw + 5, teamY)
        }

        // Stats from right edge
        let sX = statsEndX
        for (let ei = extraCols.length - 1; ei >= 0; ei--) {
          ctx.font = `500 ${Math.floor(fontSize * 0.75)}px ${font}`
          ctx.fillStyle = theme.textSecondary
          ctx.textAlign = 'right'
          ctx.fillText(fmt(p[extraCols[ei].key], extraCols[ei].format), sX, cellCY)
          sX -= extraW
        }

        // Main stat
        ctx.font = `900 ${Math.floor(fontSize * 1.25)}px ${font}`
        ctx.fillStyle = isTop3 ? '#7dd3fc' : '#e0f2fe'
        ctx.textAlign = 'right'
        if (isTop3) { ctx.shadowColor = 'rgba(125,211,252,0.3)'; ctx.shadowBlur = 20 }
        ctx.fillText(fmt(mainVal, config.format), sX, cellCY)
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'
        sX -= mainStatW

        // Record (teams only)
        if (isTeamMode) {
          ctx.font = `600 ${Math.floor(fontSize * 0.75)}px ${font}`
          ctx.fillStyle = theme.textSecondary
          ctx.textAlign = 'right'
          ctx.fillText(`${p.wins ?? 0}-${p.losses ?? 0}`, sX, cellCY)
        }
      }

      // ─── Footer ───
      const footerY = h - footerH
      ctx.strokeStyle = theme.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, footerY)
      ctx.lineTo(w, footerY)
      ctx.stroke()

      ctx.font = `500 ${Math.floor(fontSize * 0.58)}px ${font}`
      ctx.fillStyle = theme.textMuted
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText('nwbaseballstats.com', headerPadX, footerY + footerH / 2)

      ctx.textAlign = 'right'
      ctx.font = `400 ${Math.floor(fontSize * 0.52)}px ${font}`
      const qualText = isTeamMode ? 'Team Stats' : qualified ? 'Qualified' : `Min ${config.endpoint.includes('batting') ? '1 PA' : '1 IP'}`
      ctx.fillText(qualText, w - headerPadX, footerY + footerH / 2)

      // ─── Download ───
      const link = document.createElement('a')
      link.download = `nwbb-${activeConfig.key}-top${count}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details')
    } finally {
      setExporting(false)
    }
  }, [items, size, activeConfig, count, season, theme, isTeamMode, qualified, titleText, subtitle])

  const isVertical = size.h > size.w
  const isTall = size.h / size.w > 1.5
  const scale = Math.min(600 / size.w, 800 / size.h)

  // Toggle a custom extra col on/off (max 5)
  const toggleExtraCol = (key) => {
    setCustomExtraCols(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (prev.length >= 5) return prev
      return [...prev, key]
    })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Social Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">
        Create shareable leaderboard images optimized for social media.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-80 shrink-0 space-y-4">
          {/* Category */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Category</label>
            <div className="flex gap-1">
              {['batting', 'pitching', 'war', 'teams'].map(c => (
                <button key={c} onClick={() => setCategory(c)}
                  className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                    ${category === c ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{c === 'war' ? 'WAR' : c === 'teams' ? 'Teams' : c.charAt(0).toUpperCase() + c.slice(1)}</button>
              ))}
            </div>

            {/* Mode toggle (preset vs custom) */}
            {category !== 'war' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Mode</label>
                <div className="flex gap-1">
                  <button onClick={() => setMode('preset')}
                    className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                      ${mode === 'preset' ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >Presets</button>
                  <button onClick={() => setMode('custom')}
                    className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                      ${mode === 'custom' ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >Custom</button>
                </div>
              </>
            )}

            {/* Preset stat buttons */}
            {mode === 'preset' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Stat</label>
                <div className="flex flex-wrap gap-1">
                  {STAT_PRESETS[category].map((p, i) => (
                    <button key={p.key} onClick={() => setPresetIdx(i)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded transition-all
                        ${presetIdx === i ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >{p.label}</button>
                  ))}
                </div>
              </>
            )}

            {/* Custom stat picker */}
            {mode === 'custom' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Main Stat (ranked by)</label>
                <select value={customMainStat} onChange={e => setCustomMainStat(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
                  <option value="">Select stat...</option>
                  {getAvailableStats(category).map(s => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>

                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">
                  Extra Columns ({customExtraCols.length}/5)
                </label>
                <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                  {getAvailableStats(category).filter(s => s.key !== customMainStat).map(s => (
                    <button key={s.key} onClick={() => toggleExtraCol(s.key)}
                      className={`px-2 py-0.5 text-xs rounded transition-all
                        ${customExtraCols.includes(s.key)
                          ? 'bg-nw-teal text-white shadow'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}
                        ${!customExtraCols.includes(s.key) && customExtraCols.length >= 5 ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >{s.label}</button>
                  ))}
                </div>
              </>
            )}
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

            {!isTeamMode && (
              <div>
                <label className="text-xs text-gray-500">Class Year</label>
                <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All</option>
                  {['Fr', 'So', 'Jr', 'Sr'].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}

            {/* Qualified toggle */}
            {!isTeamMode && (
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500">Qualified Only</label>
                <button
                  onClick={() => setQualified(!qualified)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${qualified ? 'bg-nw-teal' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${qualified ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
            )}

            {/* Min PA/IP (only when unqualified) */}
            {!isTeamMode && !qualified && (
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs text-gray-500">Min {activeConfig.endpoint.includes('batting') ? 'PA' : 'IP'}</label>
                  <input type="number" value={minQual} onChange={e => setMinQual(e.target.value)}
                    placeholder="1"
                    className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-gray-500"># {isTeamMode ? 'Teams' : 'Players'}</label>
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
              disabled={exporting || loading || !items.length}
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
                items={items}
                config={activeConfig}
                title={titleText}
                subtitle={subtitle}
                size={size}
                loading={loading}
                isVertical={isVertical}
                isTall={isTall}
                count={count}
                theme={theme}
                isTeamMode={isTeamMode}
                qualified={qualified}
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
  { items, config, title, subtitle, size, loading, isVertical, isTall, count, theme, isTeamMode, qualified },
  ref
) {
  const w = size.w
  const h = size.h
  const isLandscape = w > h
  const extraCols = config.extra || []

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

  // Column widths
  const mainStatW = Math.floor(w * 0.10)
  const extraW = Math.floor(w * 0.09)
  const rankW = Math.floor(w * 0.045)
  const logoW = logoSize + 8

  // For team mode, show record column
  const recordW = isTeamMode ? Math.floor(w * 0.08) : 0

  return (
    <div
      ref={ref}
      style={{
        width: w,
        height: h,
        background: theme.bg,
        fontFamily: "'Inter', 'Helvetica Neue', system-ui, sans-serif",
        color: theme.textPrimary,
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
        background: `radial-gradient(circle, ${theme.orb1} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: -80, left: -80,
        width: 300, height: 300,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${theme.orb2} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* ─── Header ─── */}
      <div style={{
        height: headerH,
        padding: `${Math.floor(headerH * 0.12)}px ${Math.floor(w * 0.04)}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        borderBottom: `2px solid ${theme.border}`,
        position: 'relative',
        zIndex: 1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: isLandscape ? 5 : 8, marginBottom: isLandscape ? 1 : 4 }}>
          <img
            src="/favicon.png"
            alt=""
            style={{ width: Math.floor(titleSize * 0.8), height: Math.floor(titleSize * 0.8), borderRadius: 3 }}
            crossOrigin="anonymous"
          />
          <span style={{
            fontSize: Math.floor(titleSize * 0.35),
            fontWeight: 800,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: theme.textSecondary,
          }}>NWBB Stats</span>
        </div>
        <div style={{
          fontSize: titleSize,
          fontWeight: 900,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          color: '#ffffff',
          textShadow: `0 0 40px ${theme.accentGlow}, 0 1px 2px rgba(0,0,0,0.3)`,
        }}>
          {title}
        </div>
        <div style={{
          fontSize: subtitleSize,
          color: theme.textSecondary,
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
          padding: `0 ${Math.floor(w * 0.01)}px`,
          paddingLeft: Math.floor(w * 0.01) + 3 + rankW + logoW + 4,
          fontSize: Math.floor(fontSize * 0.6),
          fontWeight: 700,
          color: theme.textMuted,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}>
          <span style={{ flex: 1 }}>{isTeamMode ? 'Team' : 'Player'}</span>
          {isTeamMode && <span style={{ width: recordW, textAlign: 'right' }}>Record</span>}
          <span style={{ width: mainStatW, textAlign: 'right' }}>{config.label}</span>
          {extraCols.map(col => (
            <span key={col.key} style={{ width: extraW, textAlign: 'right' }}>{col.label}</span>
          ))}
        </div>

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4 }}>
            Loading...
          </div>
        ) : (
          items.slice(0, count).map((p, i) => {
            const name = isTeamMode
              ? (p.short_name || p.name || '-')
              : (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name || '-')
            const team = isTeamMode
              ? (p.conference_abbrev || '')
              : (p.team_short || p.short_name || p.team_name || '')
            const level = p.division_level || ''
            const logoUrl = p.logo_url || ''
            const mainVal = p[config.key] ?? p[config.sort]
            const isTop3 = i < 3

            return (
              <div
                key={p.id || p.player_id || p.team_id || i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: rowH,
                  padding: `0 ${Math.floor(w * 0.01)}px`,
                  borderRadius: 6,
                  background: isTop3
                    ? `linear-gradient(90deg, ${theme.highlight}${(0.22 - i * 0.05).toFixed(2)}) 0%, ${theme.highlight}0.04) 100%)`
                    : i % 2 === 0
                      ? theme.rowAlt
                      : 'transparent',
                  borderLeft: isTop3 ? `3px solid ${theme.accent}` : '3px solid transparent',
                  borderLeftColor: isTop3 ? theme.accent : 'transparent',
                  opacity: isTop3 ? 1 : undefined,
                }}
              >
                {/* Rank */}
                <span style={{
                  width: rankW,
                  fontSize: rankSize,
                  fontWeight: 900,
                  color: isTop3 ? theme.accent : theme.textMuted,
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
                      color: theme.textMuted,
                    }}>
                      {(isTeamMode ? p.short_name || p.name : team).slice(0, 3)}
                    </div>
                  )}
                </div>

                {/* Name info */}
                <div style={{ flex: 1, minWidth: 0, paddingLeft: 4, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{
                    fontSize: fontSize,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: 1.5,
                    padding: '3px 0',
                  }}>
                    {name}
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    marginTop: 0,
                    lineHeight: 1.2,
                  }}>
                    <span style={{
                      fontSize: Math.floor(fontSize * 0.68),
                      color: theme.textSecondary,
                      fontWeight: 500,
                    }}>
                      {team}
                    </span>
                    {level && (
                      <span style={{
                        fontSize: Math.floor(fontSize * 0.55),
                        fontWeight: 600,
                        color: theme.textMuted,
                        letterSpacing: '0.04em',
                      }}>
                        {level}
                      </span>
                    )}
                  </div>
                </div>

                {/* Record (teams only) */}
                {isTeamMode && (
                  <div style={{
                    width: recordW,
                    textAlign: 'right',
                    fontSize: Math.floor(fontSize * 0.75),
                    fontWeight: 600,
                    color: theme.textSecondary,
                    fontFeatureSettings: '"tnum"',
                  }}>
                    {p.wins ?? 0}-{p.losses ?? 0}
                  </div>
                )}

                {/* Main stat (big) */}
                <div style={{
                  width: mainStatW,
                  textAlign: 'right',
                  fontSize: Math.floor(fontSize * 1.25),
                  fontWeight: 900,
                  fontFeatureSettings: '"tnum"',
                  color: isTop3 ? theme.accent : '#e0f2fe',
                  textShadow: isTop3 ? `0 0 20px ${theme.accentGlow}` : 'none',
                }}>
                  {fmt(mainVal, config.format)}
                </div>

                {/* Extra stat columns */}
                {extraCols.map(col => (
                  <div key={col.key} style={{
                    width: extraW,
                    textAlign: 'right',
                    fontSize: Math.floor(fontSize * 0.75),
                    fontWeight: 500,
                    color: theme.textSecondary,
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
        borderTop: `1px solid ${theme.border}`,
        position: 'relative',
        zIndex: 1,
      }}>
        <span style={{
          fontSize: Math.floor(fontSize * 0.58),
          color: theme.textMuted,
          fontWeight: 500,
        }}>
          nwbaseballstats.com
        </span>
        <span style={{
          fontSize: Math.floor(fontSize * 0.52),
          color: theme.textMuted,
          fontWeight: 400,
        }}>
          {isTeamMode ? 'Team Stats' : qualified ? 'Qualified' : `Min ${config.endpoint.includes('batting') ? `${1} PA` : `${1} IP`}`}
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
