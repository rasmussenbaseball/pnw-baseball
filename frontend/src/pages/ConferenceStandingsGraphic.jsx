import { useState, useCallback } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Canvas utilities (same as SocialGraphics) ───
async function loadExportImage(src) {
  if (!src) return null
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
  } catch { return null }
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
  while (t.length > 0 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1)
  return t + '...'
}

// ─── Theme (matches other graphics) ───
const THEME = {
  bg1: '#0a1628',
  bg2: '#0f2744',
  bg3: '#00687a',
  accent: '#7dd3fc',
  accentGlow: 'rgba(125,211,252,0.3)',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.45)',
  textMuted: 'rgba(255,255,255,0.25)',
  border: 'rgba(255,255,255,0.08)',
  rowAlt: 'rgba(255,255,255,0.025)',
  playoffLine: 'rgba(125,211,252,0.4)',
  green: '#34d399',
  red: '#f87171',
}

export default function ConferenceStandingsGraphic() {
  const [season] = useState(2026)
  const [selectedConf, setSelectedConf] = useState(null)
  const [exporting, setExporting] = useState(false)

  const { data: result, loading } = useApi('/conference-standings-graphic', { season }, [season])
  const conferences = result?.conferences || []

  // Auto-select first conference
  if (conferences.length > 0 && selectedConf === null) {
    setSelectedConf(conferences[0].conference_id)
  }

  const activeConf = conferences.find(c => c.conference_id === selectedConf)

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!activeConf || !activeConf.teams.length) return
    setExporting(true)

    try {
      const dpr = 2
      const W = 1080, H = 1080
      const teams = activeConf.teams
      const font = 'Inter, Helvetica Neue, sans-serif'

      // Pre-load images
      const [faviconImg, ...logoImgs] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...teams.map(t => loadExportImage(t.logo_url))
      ])

      const canvas = document.createElement('canvas')
      canvas.width = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      // ─── Background gradient ───
      const ang = 160 * Math.PI / 180
      const sinA = Math.sin(ang), cosA = Math.cos(ang)
      const halfDiag = (Math.abs(W * sinA) + Math.abs(H * cosA)) / 2
      const cxG = W / 2, cyG = H / 2
      const grad = ctx.createLinearGradient(
        cxG - halfDiag * sinA, cyG + halfDiag * cosA,
        cxG + halfDiag * sinA, cyG - halfDiag * cosA
      )
      grad.addColorStop(0, THEME.bg1)
      grad.addColorStop(0.35, THEME.bg2)
      grad.addColorStop(1, THEME.bg3)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)

      // Decorative orbs
      const orb1 = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 200)
      orb1.addColorStop(0, 'rgba(0,104,122,0.3)')
      orb1.addColorStop(1, 'rgba(0,104,122,0)')
      ctx.fillStyle = orb1
      ctx.fillRect(0, 0, W, H)

      const orb2 = ctx.createRadialGradient(70, H - 70, 0, 70, H - 70, 150)
      orb2.addColorStop(0, 'rgba(0,138,158,0.15)')
      orb2.addColorStop(1, 'rgba(0,138,158,0)')
      ctx.fillStyle = orb2
      ctx.fillRect(0, 0, W, H)

      // ─── Layout constants ───
      const padX = 40
      const headerH = 140
      const footerH = 40
      const colHeaderH = 32
      const bodyTop = headerH + 8
      const bodyBottom = H - footerH - 8
      const tableH = bodyBottom - bodyTop - colHeaderH
      const rowH = Math.floor(tableH / Math.max(teams.length, 1))
      const fontSize = Math.min(Math.max(Math.floor(rowH * 0.42), 13), 20)
      const logoSize = Math.min(Math.floor(rowH * 0.6), 28)

      // ─── Header ───
      let curY = 16
      const nwLogoSz = 36
      if (faviconImg) drawImageContain(ctx, faviconImg, padX, curY, nwLogoSz, nwLogoSz)

      // "NWBB STATS" brand
      ctx.font = `800 ${14}px ${font}`
      ctx.fillStyle = THEME.textSecondary
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const brandX = padX + nwLogoSz + 8
      const brandSpacing = 2
      let charX = brandX
      for (const ch of 'NWBB STATS') {
        ctx.fillText(ch, charX, curY + nwLogoSz / 2)
        charX += ctx.measureText(ch).width + brandSpacing
      }

      curY += nwLogoSz + 10

      // Conference name title
      const confTitle = activeConf.conference_name
      ctx.font = `900 42px ${font}`
      ctx.fillStyle = THEME.textPrimary
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.shadowColor = THEME.accentGlow
      ctx.shadowBlur = 40
      ctx.fillText(confTitle, padX, curY)
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'

      curY += 52

      // Subtitle
      const divLabel = activeConf.division_level === 'JUCO' ? 'NWAC' : activeConf.division_name
      ctx.font = `500 16px ${font}`
      ctx.fillStyle = THEME.textSecondary
      ctx.fillText(`${season} Conference Standings  |  ${divLabel}`, padX, curY)

      // Header border
      ctx.strokeStyle = THEME.border
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, headerH)
      ctx.lineTo(W, headerH)
      ctx.stroke()

      // ─── Column headers ───
      // Columns: Rank | Logo | Team | Overall | Conf | Rem | SOS | GB | Rank
      const colY = bodyTop
      ctx.font = `700 ${Math.floor(fontSize * 0.55)}px ${font}`
      ctx.fillStyle = THEME.textMuted
      ctx.textBaseline = 'middle'

      // Define column positions (right-aligned data columns)
      const rankColX = padX                    // standing rank
      const logoColX = padX + 28               // team logo
      const nameColX = logoColX + logoSize + 8 // team name
      const cols = [
        { label: 'OVERALL', x: 520, align: 'center', w: 80 },
        { label: 'CONF', x: 610, align: 'center', w: 75 },
        { label: 'REM', x: 695, align: 'center', w: 45 },
        { label: 'SOS', x: 750, align: 'center', w: 45 },
        { label: 'GB', x: 808, align: 'center', w: 50 },
        { label: activeConf.teams[0]?.rank_label || 'RANK', x: 880, align: 'center', w: 60 },
      ]

      // Draw column headers
      ctx.textAlign = 'left'
      ctx.fillText('TEAM', nameColX, colY + colHeaderH / 2)

      for (const col of cols) {
        ctx.textAlign = 'center'
        ctx.fillText(col.label, col.x, colY + colHeaderH / 2)
      }

      // Thin line under column headers
      ctx.strokeStyle = THEME.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padX, colY + colHeaderH)
      ctx.lineTo(W - padX, colY + colHeaderH)
      ctx.stroke()

      // ─── Data rows ───
      const rowStartY = colY + colHeaderH

      for (let i = 0; i < teams.length; i++) {
        const t = teams[i]
        const ry = rowStartY + i * rowH
        const cellCY = ry + rowH / 2

        // Alternating row background
        if (i % 2 === 1) {
          ctx.fillStyle = THEME.rowAlt
          ctx.fillRect(padX - 8, ry, W - padX * 2 + 16, rowH)
        }

        // Playoff line
        if (activeConf.playoff_spots && i === activeConf.playoff_spots - 1 && i < teams.length - 1) {
          ctx.strokeStyle = THEME.playoffLine
          ctx.lineWidth = 1.5
          ctx.setLineDash([6, 4])
          ctx.beginPath()
          ctx.moveTo(padX, ry + rowH)
          ctx.lineTo(W - padX, ry + rowH)
          ctx.stroke()
          ctx.setLineDash([])
        }

        // Standing rank (1, 2, 3...)
        ctx.font = `700 ${fontSize}px ${font}`
        ctx.fillStyle = THEME.textSecondary
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${i + 1}`, rankColX + 10, cellCY)

        // Team logo
        if (logoImgs[i]) {
          drawImageContain(ctx, logoImgs[i], logoColX, cellCY - logoSize / 2, logoSize, logoSize)
        }

        // Team name
        ctx.font = `600 ${fontSize}px ${font}`
        ctx.fillStyle = THEME.textPrimary
        ctx.textAlign = 'left'
        const maxNameW = cols[0].x - nameColX - 20
        ctx.fillText(truncText(ctx, t.short_name || '', maxNameW), nameColX, cellCY)

        // Overall W-L
        ctx.font = `500 ${fontSize}px ${font}`
        ctx.fillStyle = THEME.textPrimary
        ctx.textAlign = 'center'
        ctx.fillText(`${t.wins}-${t.losses}`, cols[0].x, cellCY)

        // Conference W-L
        ctx.fillText(`${t.conf_wins}-${t.conf_losses}`, cols[1].x, cellCY)

        // Games remaining
        ctx.fillStyle = THEME.textSecondary
        ctx.fillText(`${t.games_remaining ?? '-'}`, cols[2].x, cellCY)

        // SOS remaining rank (1 = hardest)
        if (t.sos_remaining_rank != null) {
          // Color code: lower rank = harder = red-ish, higher = easier = green-ish
          const total = teams.length
          const pct = (t.sos_remaining_rank - 1) / Math.max(total - 1, 1)
          if (pct < 0.33) ctx.fillStyle = THEME.red
          else if (pct > 0.66) ctx.fillStyle = THEME.green
          else ctx.fillStyle = THEME.textSecondary
          ctx.fillText(`${t.sos_remaining_rank}`, cols[3].x, cellCY)
        } else {
          ctx.fillStyle = THEME.textMuted
          ctx.fillText('-', cols[3].x, cellCY)
        }

        // Games back
        const gb = t.games_back
        ctx.fillStyle = THEME.textPrimary
        if (gb === 0) {
          ctx.fillStyle = THEME.accent
          ctx.fillText('-', cols[4].x, cellCY)
        } else if (gb != null) {
          ctx.fillStyle = THEME.textSecondary
          const gbStr = gb % 1 === 0 ? `${gb}` : `${gb.toFixed(1)}`
          ctx.fillText(gbStr, cols[4].x, cellCY)
        } else {
          ctx.fillStyle = THEME.textMuted
          ctx.fillText('-', cols[4].x, cellCY)
        }

        // National/PPI rank
        if (t.rank != null) {
          ctx.font = `700 ${fontSize}px ${font}`
          ctx.fillStyle = THEME.accent
          ctx.fillText(`#${t.rank}`, cols[5].x, cellCY)
        } else {
          ctx.fillStyle = THEME.textMuted
          ctx.font = `500 ${fontSize}px ${font}`
          ctx.fillText('-', cols[5].x, cellCY)
        }
      }

      // ─── Footer ───
      const footerY = H - footerH
      ctx.strokeStyle = THEME.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, footerY)
      ctx.lineTo(W, footerY)
      ctx.stroke()

      ctx.font = `500 12px ${font}`
      ctx.fillStyle = THEME.textMuted
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText('pnwbaseballstats.com', padX, footerY + footerH / 2)

      ctx.textAlign = 'right'
      ctx.font = `400 11px ${font}`
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      ctx.fillText(`Updated ${today}`, W - padX, footerY + footerH / 2)

      // Playoff line legend (small note)
      if (activeConf.playoff_spots) {
        ctx.textAlign = 'center'
        ctx.font = `400 10px ${font}`
        ctx.fillStyle = THEME.playoffLine
        ctx.fillText(`--- Playoff cutoff (Top ${activeConf.playoff_spots})`, W / 2, footerY + footerH / 2)
      }

      // ─── Download ───
      const link = document.createElement('a')
      const safeName = activeConf.conference_abbrev || activeConf.conference_name.replace(/\s+/g, '-')
      link.download = `nwbb-standings-${safeName}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally {
      setExporting(false)
    }
  }, [activeConf, season])

  // ─── Group conferences by division for the dropdown ───
  const grouped = {}
  for (const c of conferences) {
    const divKey = c.division_name
    if (!grouped[divKey]) grouped[divKey] = []
    grouped[divKey].push(c)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Conference Standings</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate downloadable conference standings graphics for social media.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-72 shrink-0 space-y-4">
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Conference</label>
            {loading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : (
              <select
                value={selectedConf || ''}
                onChange={(e) => setSelectedConf(Number(e.target.value))}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
              >
                {Object.entries(grouped).map(([divName, confs]) => (
                  <optgroup key={divName} label={divName}>
                    {confs.map(c => (
                      <option key={c.conference_id} value={c.conference_id}>
                        {c.conference_abbrev || c.conference_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || !activeConf}
            className="w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors disabled:opacity-50"
          >
            {exporting ? 'Generating...' : 'Download PNG'}
          </button>
        </div>

        {/* ═══ RIGHT: Preview table ═══ */}
        <div className="flex-1 min-w-0">
          {activeConf ? (
            <div className="bg-white rounded-lg shadow-sm border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Team</th>
                    <th className="px-3 py-2 text-center">Overall</th>
                    <th className="px-3 py-2 text-center">Conf</th>
                    <th className="px-3 py-2 text-center">Rem</th>
                    <th className="px-3 py-2 text-center">SOS</th>
                    <th className="px-3 py-2 text-center">GB</th>
                    <th className="px-3 py-2 text-center">{activeConf.teams[0]?.rank_label || 'Rank'}</th>
                  </tr>
                </thead>
                <tbody>
                  {activeConf.teams.map((t, i) => (
                    <tr key={t.id} className={`border-t border-gray-100 ${i === activeConf.playoff_spots - 1 ? 'border-b-2 border-b-sky-300' : ''}`}>
                      <td className="px-3 py-2 text-gray-400 font-medium">{i + 1}</td>
                      <td className="px-3 py-2 font-semibold text-pnw-slate flex items-center gap-2">
                        {t.logo_url && <img src={t.logo_url} alt="" className="w-5 h-5 object-contain" />}
                        {t.short_name}
                      </td>
                      <td className="px-3 py-2 text-center">{t.wins}-{t.losses}</td>
                      <td className="px-3 py-2 text-center font-medium">{t.conf_wins}-{t.conf_losses}</td>
                      <td className="px-3 py-2 text-center text-gray-500">{t.games_remaining ?? '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-500">{t.sos_remaining_rank ?? '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-500">
                        {t.games_back === 0 ? '-' : t.games_back != null ? (t.games_back % 1 === 0 ? t.games_back : t.games_back.toFixed(1)) : '-'}
                      </td>
                      <td className="px-3 py-2 text-center font-semibold text-pnw-teal">
                        {t.rank != null ? `#${t.rank}` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400">
              Select a conference to preview standings
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
