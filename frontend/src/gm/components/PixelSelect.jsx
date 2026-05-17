/**
 * Pixel-themed dropdown that matches the GM game's dark amber palette.
 *
 * Behaves like a native <select> with grouped options BUT renders a custom
 * popover so:
 *   - The list visually matches GMShell (no white macOS chrome)
 *   - We can stuff multi-line metadata into each row (energy chip, fit tag,
 *     OVR badge) instead of being limited to a single string
 *   - Group headers can be styled differently from options
 *   - Long lists scroll inside the popover (max-h capped)
 *
 * Renders nothing fancy if you only need plain string options — pass
 * `options` and `value` + `onChange` just like a native select.
 *
 * Usage:
 *   <PixelSelect
 *     value={slot.playerId}
 *     onChange={(v) => setSlotPlayer(i, v)}
 *     placeholder="— pick player —"
 *     groups={[
 *       { label: "Plays C", items: [
 *         { value: 'p1', label: 'Joel Turner', sub: 'C · SO · OVR 82' },
 *       ]},
 *     ]}
 *   />
 */

import { useEffect, useRef, useState } from 'react'

export default function PixelSelect({
  value,
  onChange,
  options = null,           // [{value, label, sub?, disabled?, render?}]
  groups = null,            // [{label, items: [{value, label, sub?, disabled?, render?}]}]
  placeholder = '— select —',
  className = '',
  width = null,             // CSS width string; default flex-1
  maxListHeight = 360,
  buttonClassName = '',
  align = 'start',          // 'start' | 'end' for right-aligning short selects
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const buttonRef = useRef(null)

  // Resolve the currently-selected item's display label by scanning the
  // flat option list and group items in order.
  const selectedItem = (() => {
    if (options) return options.find(o => o.value === value)
    if (groups) {
      for (const g of groups) {
        const hit = (g.items || []).find(o => o.value === value)
        if (hit) return hit
      }
    }
    return null
  })()

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target)) return
      setOpen(false)
    }
    function key(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  function pick(v, disabled) {
    if (disabled) return
    onChange(v)
    setOpen(false)
  }

  const rootClass = 'relative ' + (width ? '' : 'flex-1 ') + className
  const widthStyle = width ? { width } : null

  return (
    <div ref={rootRef} className={rootClass} style={widthStyle}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={
          'w-full text-left bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-2 py-1 text-sm text-white hover:border-amber-400 transition flex items-center justify-between gap-2 ' +
          buttonClassName
        }
      >
        <span className="truncate">
          {selectedItem ? (
            <span>
              {selectedItem.label}
              {selectedItem.sub && (
                <span className="text-[10px] text-[#a8a8c8] ml-1.5">{selectedItem.sub}</span>
              )}
            </span>
          ) : (
            <span className="text-[#a8a8c8]">{placeholder}</span>
          )}
        </span>
        <span className="text-amber-300 text-xs shrink-0">▾</span>
      </button>

      {open && (
        <div
          className={
            'absolute z-50 mt-1 bg-[#0f0f1e] border-2 border-amber-400 rounded shadow-xl overflow-hidden ' +
            (align === 'end' ? 'right-0' : 'left-0 right-0')
          }
          style={{ minWidth: '100%', maxHeight: maxListHeight }}
        >
          <div className="overflow-y-auto" style={{ maxHeight: maxListHeight }}>
            {options && options.map(opt => (
              <PixelOption
                key={opt.value}
                opt={opt}
                active={opt.value === value}
                onPick={pick}
              />
            ))}
            {groups && groups.map((g, gi) => (
              <div key={'g_' + gi}>
                {g.label && (
                  <div className="px-2 py-1 bg-[#1a1a2e] border-b border-[#3a3a5e] text-[9px] uppercase tracking-widest text-amber-300 font-pixel font-bold">
                    {g.label}
                  </div>
                )}
                {(g.items || []).map(opt => (
                  <PixelOption
                    key={opt.value}
                    opt={opt}
                    active={opt.value === value}
                    onPick={pick}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PixelOption({ opt, active, onPick }) {
  const cls =
    'w-full text-left px-2 py-1.5 text-sm cursor-pointer transition flex items-center justify-between gap-2 ' +
    (opt.disabled
      ? 'text-[#666680] cursor-not-allowed'
      : active
        ? 'bg-amber-400 text-[#1a1a2e] font-bold'
        : 'text-[#e8e8e8] hover:bg-amber-400/15')
  if (opt.render) {
    return (
      <button type="button" disabled={opt.disabled} onClick={() => onPick(opt.value, opt.disabled)} className={cls}>
        {opt.render({ active })}
      </button>
    )
  }
  return (
    <button type="button" disabled={opt.disabled} onClick={() => onPick(opt.value, opt.disabled)} className={cls}>
      <span className="truncate">{opt.label}</span>
      {opt.sub && (
        <span className={'text-[10px] shrink-0 ' + (active ? 'opacity-80' : 'text-[#a8a8c8]')}>
          {opt.sub}
        </span>
      )}
    </button>
  )
}
