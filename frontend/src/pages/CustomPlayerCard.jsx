/**
 * Custom Player Card builder — /portal/custom-card.
 *
 * Pick a player, then add / reorder / resize / configure blocks onto a single
 * letter-size card that auto-scales so everything always fits on ONE page.
 * Blocks include live stat panels, charts, auto "how to attack" notes, and
 * coach-entered report blocks (20-80 grades, measurables, scout's take, blank
 * notes). Save a layout as a reusable TEMPLATE and feed it into bulk card
 * generation for a whole roster. Export a single card as PDF or PNG.
 *
 * The card itself renders via the shared <CustomCard> (CustomCard.jsx) so a
 * template previews here exactly as it prints in a bulk run.
 */

import { useState, useRef, useCallback } from 'react'
import { usePlayerSearch } from '../hooks/useApi'
import ReportActions from '../components/ReportActions'
import {
  CustomCard, BLOCKS, PALETTE_GROUPS, DEFAULT_BLOCKS, withUids, nextUid,
  SPRAY_FILTERS_HIT, SPRAY_FILTERS_PIT,
} from './CustomCard'
import { HIT_TOOLS, PIT_TOOLS, MEAS } from './PlayerCardPDF'
import { loadTemplates, saveTemplate, deleteTemplate } from '../lib/cardTemplates'

const GRADE_OPTS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]

export default function CustomPlayerCard() {
  const [query, setQuery] = useState('')
  const [playerId, setPlayerId] = useState(null)
  const [sideParam, setSideParam] = useState(null)  // null = auto
  const [blocks, setBlocks] = useState(() => withUids(DEFAULT_BLOCKS))
  const [meta, setMeta] = useState({ player: null, side: 'batting', hasBatting: false, hasPitching: false })
  const [editingUid, setEditingUid] = useState(null)

  const [templates, setTemplates] = useState(() => loadTemplates())
  const [tplName, setTplName] = useState('')
  const [savedFlash, setSavedFlash] = useState('')

  const { data: results } = usePlayerSearch(query.length >= 2 ? query : '')
  const pageRef = useRef(null)

  const onMeta = useCallback((m) => setMeta(prev => (
    prev.player?.id === m.player?.id && prev.side === m.side
      && prev.hasBatting === m.hasBatting && prev.hasPitching === m.hasPitching ? prev : m
  )), [])

  const { player, side, hasBatting, hasPitching } = meta
  const sprayFilters = side === 'pitching' ? SPRAY_FILTERS_PIT : SPRAY_FILTERS_HIT

  // ── block ops ──
  const addBlock = type => {
    const seed = { uid: nextUid(), type, w: BLOCKS[type].w }
    if (BLOCKS[type].spray) seed.filter = 'all'
    if (BLOCKS[type].edit === 'notes') { seed.title = 'Notes'; seed.lines = 4 }
    setBlocks(b => [...b, seed])
  }
  const removeBlock = uid => { setBlocks(b => b.filter(x => x.uid !== uid)); if (editingUid === uid) setEditingUid(null) }
  const move = (i, d) => setBlocks(b => { const n = [...b]; const j = i + d; if (j < 0 || j >= n.length) return b;[n[i], n[j]] = [n[j], n[i]]; return n })
  const setW = (uid, w) => setBlocks(b => b.map(x => x.uid === uid ? { ...x, w } : x))
  const patchBlock = (uid, patch) => setBlocks(b => b.map(x => x.uid === uid ? { ...x, ...patch } : x))

  // ── templates ──
  const refreshTemplates = () => setTemplates(loadTemplates())
  const onSaveTemplate = () => {
    const name = tplName.trim()
    if (!name) return
    saveTemplate({ name, blocks, sidePref: sideParam || 'auto', now: Date.now() })
    refreshTemplates()
    setTplName('')
    setSavedFlash(name)
    setTimeout(() => setSavedFlash(''), 2000)
  }
  const onLoadTemplate = (t) => {
    setBlocks(withUids(t.blocks))
    setSideParam(t.sidePref && t.sidePref !== 'auto' ? t.sidePref : null)
    setEditingUid(null)
  }
  const onDeleteTemplate = (id) => { deleteTemplate(id); refreshTemplates() }

  return (
    <div className="max-w-full mx-auto px-3 sm:px-5 py-5">
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ── Builder controls ── */}
        <div className="space-y-3 lg:sticky lg:top-3 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-auto pr-1">
          <h1 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Custom Player Card</h1>

          {/* Player search */}
          <div className="relative">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a player..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal" />
            {query.length >= 2 && results?.length > 0 && !playerId && (
              <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-200 rounded-lg shadow-lg">
                {results.slice(0, 12).map(p => (
                  <button key={p.id} onClick={() => { setPlayerId(p.id); setQuery(`${p.first_name} ${p.last_name}`); setSideParam(null) }}
                    className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700">
                    {p.first_name} {p.last_name} <span className="text-xs text-gray-400">{p.team_short || p.team_name} · {p.position}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {playerId && (
            <button onClick={() => { setPlayerId(null); setQuery('') }} className="text-xs text-nw-teal hover:underline">Change player</button>
          )}

          {/* Side toggle */}
          {playerId && hasBatting && hasPitching && (
            <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
              {['batting', 'pitching'].map(s => (
                <button key={s} onClick={() => setSideParam(s)}
                  className={`px-3 py-1.5 text-sm font-medium capitalize ${side === s ? 'bg-portal-purple text-portal-cream' : 'bg-white dark:bg-gray-700 text-gray-600'}`}>{s}</button>
              ))}
            </div>
          )}

          {/* Templates */}
          <div className="border border-portal-purple/30 dark:border-portal-purple/50 rounded-lg p-3 bg-portal-purple/[0.03]">
            <div className="text-[11px] font-bold uppercase tracking-wide text-portal-purple-dark dark:text-portal-accent mb-1.5">Templates</div>
            {templates.length > 0 && (
              <div className="space-y-1 mb-2">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center gap-1.5 text-xs bg-white dark:bg-gray-800 rounded px-2 py-1 border border-gray-200 dark:border-gray-700">
                    <button onClick={() => onLoadTemplate(t)} className="flex-1 text-left font-medium text-portal-purple dark:text-portal-accent hover:underline truncate" title="Load template">
                      {t.name}
                    </button>
                    <span className="text-[10px] text-gray-400">{t.blocks?.length || 0} blk · {t.sidePref}</span>
                    <button onClick={() => onDeleteTemplate(t.id)} className="px-1 text-gray-400 hover:text-rose-600" title="Delete">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input value={tplName} onChange={e => setTplName(e.target.value)} placeholder="Save current layout as…"
                className="flex-1 px-2 py-1 rounded border border-gray-300 text-xs focus:outline-none focus:ring-1 focus:ring-nw-teal" />
              <button onClick={onSaveTemplate} disabled={!tplName.trim()}
                className="px-2.5 py-1 rounded bg-portal-purple text-portal-cream text-xs font-semibold disabled:opacity-40">Save</button>
            </div>
            {savedFlash && <div className="text-[10px] text-green-700 mt-1">Saved “{savedFlash}”. It's now available in bulk generation.</div>}
          </div>

          {/* Palette — grouped */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Add a block</div>
            <div className="space-y-2">
              {PALETTE_GROUPS.map(group => {
                const types = Object.keys(BLOCKS).filter(t => BLOCKS[t].tag === group)
                if (!types.length) return null
                return (
                  <div key={group}>
                    <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-1">{group}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {types.map(type => (
                        <button key={type} onClick={() => addBlock(type)}
                          className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-nw-teal/10 hover:border-nw-teal text-gray-700 dark:text-gray-300">
                          + {BLOCKS[type].label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Selected blocks */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Card layout ({blocks.length})</div>
            <div className="space-y-1.5">
              {blocks.map((b, i) => (
                <div key={b.uid} className="bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="flex-1 font-medium text-gray-700 dark:text-gray-200 truncate">{BLOCKS[b.type].label}</span>
                    {BLOCKS[b.type].spray && (
                      <select value={b.filter} onChange={e => patchBlock(b.uid, { filter: e.target.value })}
                        className="text-[11px] border border-gray-300 rounded px-1 py-0.5">
                        {sprayFilters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    )}
                    {BLOCKS[b.type].edit && (
                      <button onClick={() => setEditingUid(editingUid === b.uid ? null : b.uid)}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${editingUid === b.uid ? 'bg-nw-teal text-white border-nw-teal' : 'border-gray-300 hover:bg-gray-100'}`}
                        title="Configure">⚙</button>
                    )}
                    <button onClick={() => setW(b.uid, b.w === 'full' ? 'half' : 'full')}
                      className="px-1.5 py-0.5 rounded border border-gray-300 text-[10px] hover:bg-gray-100" title="Toggle width">
                      {b.w === 'full' ? 'Full' : 'Half'}
                    </button>
                    <button onClick={() => move(i, -1)} className="px-1 text-gray-500 hover:text-nw-teal" title="Up">▲</button>
                    <button onClick={() => move(i, 1)} className="px-1 text-gray-500 hover:text-nw-teal" title="Down">▼</button>
                    <button onClick={() => removeBlock(b.uid)} className="px-1 text-gray-400 hover:text-rose-600" title="Remove">✕</button>
                  </div>
                  {editingUid === b.uid && BLOCKS[b.type].edit && (
                    <BlockEditor block={b} side={side} onChange={patch => patchBlock(b.uid, patch)} />
                  )}
                </div>
              ))}
              {!blocks.length && <div className="text-xs text-gray-400 italic">Add blocks from the palette above.</div>}
            </div>
          </div>

          {player && <ReportActions targetRef={pageRef} pdfFromCanvas
            filename={`card_${(player.last_name || 'player')}_${player.first_name || ''}_${side}`.replace(/\s+/g, '')} />}
        </div>

        {/* ── Live card (fixed one-page size, auto-fit) ── */}
        <div className="overflow-auto">
          {!playerId ? (
            <div className="custom-card-page bg-white mx-auto shadow border border-gray-200 p-8 text-gray-400 italic text-sm"
              style={{ width: '816px', height: '1056px' }}>
              Search and pick a player to start building a card.
            </div>
          ) : (
            <CustomCard playerId={playerId} blocks={blocks} sideParam={sideParam} cardRef={pageRef} onMeta={onMeta} />
          )}
          <p className="text-[11px] text-gray-400 mt-2 text-center">Card auto-scales to one letter page. The more blocks you add, the smaller everything gets. Save a layout as a template to reuse it in bulk generation.</p>
        </div>
      </div>
    </div>
  )
}


// ── Per-block config editors ──
function BlockEditor({ block, side, onChange }) {
  const kind = BLOCKS[block.type].edit
  if (kind === 'text') {
    return (
      <div className="mt-1.5">
        <textarea value={block.text || ''} onChange={e => onChange({ text: e.target.value })} rows={4}
          placeholder="Type the scouting narrative… (leave blank to print ruled write-in lines)"
          className="w-full px-2 py-1 text-xs border border-gray-300 rounded resize-y focus:outline-none focus:ring-1 focus:ring-nw-teal" />
      </div>
    )
  }
  if (kind === 'notes') {
    return (
      <div className="mt-1.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <input value={block.title || ''} onChange={e => onChange({ title: e.target.value })} placeholder="Box title (e.g. Defense)"
            className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-nw-teal" />
          <label className="text-[10px] text-gray-500 flex items-center gap-1">
            lines
            <input type="number" min={2} max={8} value={block.lines || 4} onChange={e => onChange({ lines: Number(e.target.value) })}
              className="w-12 px-1 py-1 text-xs border border-gray-300 rounded" />
          </label>
        </div>
        <textarea value={block.text || ''} onChange={e => onChange({ text: e.target.value })} rows={2}
          placeholder="Optional pre-filled text (blank = ruled write-in lines)"
          className="w-full px-2 py-1 text-xs border border-gray-300 rounded resize-y focus:outline-none focus:ring-1 focus:ring-nw-teal" />
      </div>
    )
  }
  if (kind === 'grades') {
    const tools = side === 'pitching' ? PIT_TOOLS : HIT_TOOLS
    const grades = block.grades || {}
    const setGrade = (k, pf, v) => onChange({ grades: { ...grades, [k]: { ...(grades[k] || {}), [pf]: v ? Number(v) : undefined } } })
    return (
      <div className="mt-1.5">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1 items-center text-[11px]">
          <span className="text-gray-400" />
          <span className="text-gray-500 text-center font-bold w-14">Present</span>
          <span className="text-gray-500 text-center font-bold w-14">Future</span>
          {tools.map(([k, label]) => (
            <FragmentRow key={k} label={label}>
              {['p', 'f'].map(pf => (
                <select key={pf} value={grades[k]?.[pf] || ''} onChange={e => setGrade(k, pf, e.target.value)}
                  className="w-14 px-1 py-0.5 text-[11px] border border-gray-300 rounded text-center">
                  <option value="">–</option>
                  {GRADE_OPTS.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              ))}
            </FragmentRow>
          ))}
        </div>
        <div className="text-[9px] text-gray-400 mt-1">OFP auto-calculates from the Future grades.</div>
      </div>
    )
  }
  if (kind === 'measurables') {
    const values = block.values || {}
    const setVal = (k, v) => onChange({ values: { ...values, [k]: v } })
    return (
      <div className="mt-1.5 space-y-1.5">
        <div className="flex gap-2">
          <label className="flex-1 text-[10px] text-gray-500">Height
            <input value={values.height || ''} onChange={e => setVal('height', e.target.value)} placeholder="6-2"
              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded" /></label>
          <label className="flex-1 text-[10px] text-gray-500">Weight
            <input value={values.weight || ''} onChange={e => setVal('weight', e.target.value)} placeholder="190"
              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded" /></label>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {MEAS.map(m => (
            <label key={m.key} className="text-[10px] text-gray-500">{m.label}{m.unit ? ` (${m.unit})` : ''}
              <input value={values[m.key] || ''} onChange={e => setVal(m.key, e.target.value)}
                className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded" /></label>
          ))}
        </div>
        <div className="text-[9px] text-gray-400">Only filled-in rows appear on the card. Shading uses approx. college benchmarks.</div>
      </div>
    )
  }
  return null
}

// Tiny helper so the grades grid stays a clean 3-col layout.
function FragmentRow({ label, children }) {
  return (
    <>
      <span className="text-gray-700 dark:text-gray-300">{label}</span>
      {children}
    </>
  )
}
