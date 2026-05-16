/**
 * Pixel-art headshot for a player. Deterministic from playerId so the same
 * player always renders the same face. Variety comes from composing:
 *
 *   - 9 skin tones spanning light to deep
 *   - 9 hair colors + a bald option
 *   - 4 hair styles (short crop, longer hair below cap, curly, none)
 *   - 5 facial hair options (clean, stubble, mustache, goatee, full beard)
 *   - cap color from team
 *   - jersey color from team
 *
 * Render as an inline SVG (no images, no fonts, fast). 16×16 grid scaled
 * to the size prop. crisp-edges rendering keeps the pixel feel.
 *
 *   <PixelHeadshot playerId={p.id} capColor="#aa0000" jerseyColor="#fbbf24" size={48} />
 */

// ─── Palettes ──────────────────────────────────────────────────────────────

const SKIN_TONES = [
  '#FBD3B0', '#F5C09A', '#E5A982', '#D49B72',
  '#B97B5A', '#9A6447', '#7A4F37', '#5E3922', '#432A18',
]

const SKIN_SHADOWS = [
  '#E8B895', '#DBA77F', '#C68F6A', '#B5825D',
  '#9A6347', '#7E4F36', '#5F3D28', '#472A18', '#2F1B0E',
]

const HAIR_COLORS = [
  '#1A1A1A', '#2B1810', '#3C2415', '#5C3A1F',
  '#7A4F2A', '#A07050', '#D1A055', '#DDB572',
  '#BB4422', '#9C5B2A', '#7A7A7A', '#A8A8A8',
]

// Hair "style" — controls how hair sits around the cap. 0 = none/bald,
// 1 = short crop (small bit visible at sideburns + nape), 2 = longer hair
// visible below cap, 3 = curly/textured (different pixel pattern).
const HAIR_STYLES = [0, 1, 1, 1, 2, 2, 3]   // weighted: short crops most common

// Facial hair. 0 = clean shaven (most common), 1 = stubble, 2 = mustache,
// 3 = goatee/chin patch, 4 = full beard.
const FACIAL_HAIR = [0, 0, 0, 1, 1, 2, 3, 4]

// Eye options — just a couple variations for visual distinction
const EYE_VARIANTS = ['default', 'wide', 'narrow']

// ─── Deterministic hash from playerId ──────────────────────────────────────

function pHash(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < (str || '').length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pickFromSeed(arr, seed) {
  return arr[seed % arr.length]
}

// ─── Headshot ──────────────────────────────────────────────────────────────

/**
 * @param {{ playerId: string, capColor?: string, jerseyColor?: string,
 *           capAccent?: string, size?: number, className?: string }} props
 */
export default function PixelHeadshot({
  playerId,
  capColor = '#8B0000',
  jerseyColor = '#fbbf24',
  capAccent = '#FFFFFF',
  size = 48,
  className = '',
}) {
  // Seed all picks from the player id so the same player always looks the same
  const base = pHash(playerId || 'anon')
  const skinIdx  = base % SKIN_TONES.length
  const hairIdx  = (base >> 4) % HAIR_COLORS.length
  const styleIdx = (base >> 8) % HAIR_STYLES.length
  const faceIdx  = (base >> 12) % FACIAL_HAIR.length
  const eyeIdx   = (base >> 16) % EYE_VARIANTS.length

  const skin     = SKIN_TONES[skinIdx]
  const skinShd  = SKIN_SHADOWS[skinIdx]
  const hair     = HAIR_COLORS[hairIdx]
  const hairStyle = HAIR_STYLES[styleIdx]
  const facialHair = FACIAL_HAIR[faceIdx]
  const eyeStyle = EYE_VARIANTS[eyeIdx]

  // Build the 16×16 pixel grid. Each row is 16 cells; we draw with SVG <rect>.
  // Coordinates: x=0 is left, y=0 is top. Cap covers rows 1-4, head 4-10,
  // shoulders 11-15.
  const pixels = buildPixels({
    skin, skinShd, hair, hairStyle, facialHair, eyeStyle,
    capColor, jerseyColor, capAccent,
  })

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Background fill — slightly lighter than the shell card so the
          face sits on its own surface even at small sizes. */}
      <rect x="0" y="0" width="16" height="16" fill="#2f2f4f" />
      {pixels.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width="1" height="1" fill={p.c} />
      ))}
      {/* Inner 1-px ring drawn as 4 edge rects so the headshot pops on
          BOTH the dark pixel shell AND any legacy light surface (Recruiting
          modal, Roster table, etc.). Uses crisp pixel borders. */}
      <rect x="0" y="0" width="16" height="1" fill="#3a3a5e" />
      <rect x="0" y="15" width="16" height="1" fill="#3a3a5e" />
      <rect x="0" y="0" width="1" height="16" fill="#3a3a5e" />
      <rect x="15" y="0" width="1" height="16" fill="#3a3a5e" />
    </svg>
  )
}

// ─── Pixel grid builder ────────────────────────────────────────────────────

/**
 * Build the array of { x, y, c } pixels. Drawn in order; later pixels paint
 * over earlier ones.
 */
function buildPixels({ skin, skinShd, hair, hairStyle, facialHair, eyeStyle, capColor, jerseyColor, capAccent }) {
  const pixels = []
  function p(x, y, c) { pixels.push({ x, y, c }) }
  function fill(x1, y1, x2, y2, c) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) p(x, y, c)
    }
  }

  // ── Head shape (skin, rows 4-10, cols 4-11) ───────────────────────────
  fill(4, 4, 11, 10, skin)
  // Side jaw shadow
  p(4, 9, skinShd); p(11, 9, skinShd)
  p(4, 10, skinShd); p(11, 10, skinShd)
  // Chin
  fill(5, 11, 10, 11, skin)
  p(5, 11, skinShd); p(10, 11, skinShd)
  // Neck
  fill(6, 12, 9, 13, skinShd)

  // ── Hair under cap (only if hair style > 0) ───────────────────────────
  if (hairStyle === 1) {
    // Short crop — sideburns + nape strip
    p(4, 5, hair); p(11, 5, hair)
    p(4, 6, hair); p(11, 6, hair)
  } else if (hairStyle === 2) {
    // Longer hair visible below cap
    p(3, 5, hair); p(4, 5, hair); p(11, 5, hair); p(12, 5, hair)
    p(3, 6, hair); p(4, 6, hair); p(11, 6, hair); p(12, 6, hair)
    p(4, 7, hair); p(11, 7, hair)
  } else if (hairStyle === 3) {
    // Curly / textured — staggered pixels around brim
    p(3, 5, hair); p(5, 5, hair); p(10, 5, hair); p(12, 5, hair)
    p(4, 6, hair); p(11, 6, hair)
    p(3, 7, hair); p(12, 7, hair)
  }

  // ── Cap (rows 1-4, full width over head) ──────────────────────────────
  // Cap top (slightly narrower)
  fill(4, 1, 11, 1, capColor)
  fill(3, 2, 12, 3, capColor)
  fill(3, 4, 12, 4, capColor)
  // Cap brim — extends right
  fill(8, 5, 13, 5, capColor)
  p(13, 5, '#1a1a1a')   // brim shadow tip
  // Cap shading (top-left highlight, bottom-right shadow)
  p(4, 2, lighten(capColor))
  p(5, 2, lighten(capColor))
  p(11, 4, darken(capColor))
  p(12, 4, darken(capColor))
  p(12, 5, darken(capColor))
  // Cap logo / accent — a single bright pixel center-front
  p(7, 3, capAccent)
  p(8, 3, capAccent)

  // ── Eyes ──────────────────────────────────────────────────────────────
  if (eyeStyle === 'wide') {
    p(6, 7, '#1a1a1a'); p(9, 7, '#1a1a1a')
    p(5, 7, '#FFFFFF'); p(10, 7, '#FFFFFF')   // wider eye whites
  } else if (eyeStyle === 'narrow') {
    p(6, 7, '#1a1a1a'); p(9, 7, '#1a1a1a')
  } else {
    p(6, 7, '#1a1a1a'); p(9, 7, '#1a1a1a')
    p(7, 7, skin); p(8, 7, skin)   // bridge of nose
  }

  // ── Facial hair ───────────────────────────────────────────────────────
  if (facialHair === 1) {
    // Stubble — scattered darker pixels on chin
    p(6, 10, skinShd); p(7, 10, skinShd); p(8, 10, skinShd); p(9, 10, skinShd)
  } else if (facialHair === 2) {
    // Mustache
    p(6, 9, hair); p(7, 9, hair); p(8, 9, hair); p(9, 9, hair)
  } else if (facialHair === 3) {
    // Goatee / chin patch
    p(7, 10, hair); p(8, 10, hair)
    p(7, 11, hair); p(8, 11, hair)
  } else if (facialHair === 4) {
    // Full beard
    p(5, 9, hair); p(10, 9, hair)
    fill(5, 10, 10, 10, hair)
    fill(5, 11, 10, 11, hair)
    p(6, 9, hair); p(9, 9, hair)
    // Mouth gap stays skin-toned
    p(7, 10, skin); p(8, 10, skin)
  }

  // ── Jersey / shoulders (rows 14-15) ───────────────────────────────────
  fill(3, 14, 12, 15, jerseyColor)
  // Jersey shading at edges + base
  p(3, 14, darken(jerseyColor)); p(12, 14, darken(jerseyColor))
  fill(3, 15, 12, 15, darken(jerseyColor))

  return pixels
}

// ─── Color helpers ─────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = hex.replace('#', '')
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  }
}
function rgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + c(r) + c(g) + c(b)
}
function lighten(hex, amt = 0.2) {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt)
}
function darken(hex, amt = 0.3) {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt))
}
