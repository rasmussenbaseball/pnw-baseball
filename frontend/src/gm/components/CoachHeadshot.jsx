/**
 * CoachHeadshot — pixel-art portrait for a coach. Same 16×16 art style as
 * PixelHeadshot but with slightly different proportions + always wears a
 * collared polo or windbreaker instead of a jersey. The HC slot also draws
 * a small hat brim.
 *
 * Coaches pick from a fixed roster of 20 "looks" by passing a `lookId`
 * (0-19). The look determines skin tone, hair color + style, facial hair,
 * and polo color combo. Used on the New Dynasty coach builder so users
 * can pick their own portrait.
 */

const SIZE = 16
const PX = (n, s) => Math.round(n * s / SIZE)

const SKINS = [
  '#f5d0a9', '#eecaa3', '#e0b88e', '#c69175', '#a87055',
  '#8e5a3b', '#6c4023', '#4f2e18', '#3a221b',
]
const HAIR_COLORS = [
  '#2b2118', '#3b2818', '#5b3a1f', '#7a5230', '#a07549',
  '#c39459', '#d7b27a', '#9b9b9b', '#5b5b5b', '#1a1a1a',
  '#7a6a55', '#aa5b32',
]
const HAIR_STYLES = ['short', 'side-part', 'buzz', 'receding', 'bald']
const FACIAL_HAIRS = ['none', 'mustache', 'goatee', 'short-beard', 'full-beard']
const POLO_COLORS = [
  '#23233d', '#1a4d2e', '#4a1c1c', '#1f3c5a', '#5a3b1c',
  '#3a3a5e', '#2d1b3a', '#1c3a4a',
]

// 20 hand-curated "looks" — combinations of skin/hair/style/beard/polo that
// produce visually distinct portraits. Users pick by lookId.
export const COACH_LOOKS = [
  // Light skin tones
  { id: 0,  skin: 0, hair: 0, hairStyle: 'side-part', facialHair: 'none',        polo: 0 },
  { id: 1,  skin: 1, hair: 1, hairStyle: 'short',     facialHair: 'short-beard', polo: 1 },
  { id: 2,  skin: 0, hair: 2, hairStyle: 'receding',  facialHair: 'goatee',      polo: 2 },
  { id: 3,  skin: 2, hair: 3, hairStyle: 'short',     facialHair: 'full-beard',  polo: 3 },
  { id: 4,  skin: 1, hair: 7, hairStyle: 'buzz',      facialHair: 'mustache',    polo: 4 },
  // Mid skin tones
  { id: 5,  skin: 3, hair: 0, hairStyle: 'short',     facialHair: 'none',        polo: 5 },
  { id: 6,  skin: 3, hair: 9, hairStyle: 'bald',      facialHair: 'short-beard', polo: 1 },
  { id: 7,  skin: 4, hair: 0, hairStyle: 'side-part', facialHair: 'goatee',      polo: 6 },
  { id: 8,  skin: 4, hair: 4, hairStyle: 'short',     facialHair: 'none',        polo: 0 },
  { id: 9,  skin: 5, hair: 0, hairStyle: 'short',     facialHair: 'mustache',    polo: 7 },
  // Darker skin tones
  { id: 10, skin: 6, hair: 9, hairStyle: 'buzz',      facialHair: 'none',        polo: 1 },
  { id: 11, skin: 6, hair: 9, hairStyle: 'short',     facialHair: 'short-beard', polo: 2 },
  { id: 12, skin: 7, hair: 9, hairStyle: 'bald',      facialHair: 'full-beard',  polo: 3 },
  { id: 13, skin: 7, hair: 9, hairStyle: 'short',     facialHair: 'mustache',    polo: 4 },
  { id: 14, skin: 8, hair: 9, hairStyle: 'buzz',      facialHair: 'goatee',      polo: 5 },
  // Gray + senior coaches
  { id: 15, skin: 1, hair: 7, hairStyle: 'side-part', facialHair: 'short-beard', polo: 6 },
  { id: 16, skin: 3, hair: 8, hairStyle: 'receding',  facialHair: 'goatee',      polo: 7 },
  { id: 17, skin: 0, hair: 7, hairStyle: 'short',     facialHair: 'full-beard',  polo: 0 },
  // Variety
  { id: 18, skin: 5, hair: 11, hairStyle: 'short',    facialHair: 'short-beard', polo: 2 },
  { id: 19, skin: 2, hair: 5, hairStyle: 'side-part', facialHair: 'none',        polo: 4 },
  // Expanded set (May 2026) — more distinct coach faces so assistants
  // across the league repeat far less.
  { id: 20, skin: 0, hair: 3, hairStyle: 'short',     facialHair: 'full-beard',  polo: 5 },
  { id: 21, skin: 1, hair: 5, hairStyle: 'receding',  facialHair: 'none',        polo: 7 },
  { id: 22, skin: 2, hair: 0, hairStyle: 'buzz',      facialHair: 'goatee',      polo: 1 },
  { id: 23, skin: 2, hair: 8, hairStyle: 'bald',      facialHair: 'mustache',    polo: 3 },
  { id: 24, skin: 3, hair: 1, hairStyle: 'side-part', facialHair: 'short-beard', polo: 0 },
  { id: 25, skin: 3, hair: 4, hairStyle: 'short',     facialHair: 'full-beard',  polo: 6 },
  { id: 26, skin: 4, hair: 9, hairStyle: 'buzz',      facialHair: 'short-beard', polo: 2 },
  { id: 27, skin: 4, hair: 2, hairStyle: 'receding',  facialHair: 'none',        polo: 5 },
  { id: 28, skin: 5, hair: 9, hairStyle: 'short',     facialHair: 'goatee',      polo: 4 },
  { id: 29, skin: 6, hair: 9, hairStyle: 'bald',      facialHair: 'mustache',    polo: 0 },
  { id: 30, skin: 6, hair: 9, hairStyle: 'side-part', facialHair: 'none',        polo: 7 },
  { id: 31, skin: 7, hair: 9, hairStyle: 'buzz',      facialHair: 'short-beard', polo: 1 },
  { id: 32, skin: 8, hair: 9, hairStyle: 'short',     facialHair: 'full-beard',  polo: 6 },
  { id: 33, skin: 1, hair: 8, hairStyle: 'bald',      facialHair: 'goatee',      polo: 3 },
  { id: 34, skin: 0, hair: 10, hairStyle: 'short',    facialHair: 'mustache',    polo: 5 },
  { id: 35, skin: 5, hair: 7, hairStyle: 'receding',  facialHair: 'short-beard', polo: 2 },
]

// Stable hash of a string → unsigned 32-bit int. Used to derive a deterministic
// lookId for coaches who don't have one set (assistants, AI HCs).
function stableHash(s) {
  let h = 0
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

export default function CoachHeadshot({ lookId, coachId, size = 48, className = '' }) {
  // If lookId is missing (most generated coaches), derive one deterministically
  // from coachId so the same coach gets the same face on every render.
  const effectiveLookId = (typeof lookId === 'number')
    ? lookId
    : (coachId ? stableHash(coachId) % COACH_LOOKS.length : 0)
  const look = COACH_LOOKS[effectiveLookId % COACH_LOOKS.length]
  const skin = SKINS[look.skin] || SKINS[0]
  const skinShd = darken(skin, 0.2)
  const hair = HAIR_COLORS[look.hair] || HAIR_COLORS[0]
  const polo = POLO_COLORS[look.polo] || POLO_COLORS[0]
  const poloShd = darken(polo, 0.25)
  const poloHi = lighten(polo, 0.10)

  const pixels = buildPixels({
    skin, skinShd, hair,
    hairStyle: look.hairStyle, facialHair: look.facialHair,
    polo, poloShd, poloHi,
  })

  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={'pixel-headshot ' + className}
      style={{ imageRendering: 'pixelated' }}
    >
      {pixels.map((row, y) =>
        row.map((color, x) => color ? (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
        ) : null)
      )}
      {/* subtle pixel ring around face */}
      <rect x="0" y="0" width="16" height="16" fill="none" stroke="rgba(0,0,0,0.20)" strokeWidth="0.5" />
    </svg>
  )
}

function buildPixels({ skin, skinShd, hair, hairStyle, facialHair, polo, poloShd, poloHi }) {
  // 16×16 grid. row 0 is top.
  const grid = Array.from({ length: 16 }, () => Array(16).fill(null))

  // ── Polo / collar (rows 12-15) ─────────────────────────────────────
  // Body fill
  for (let y = 12; y < 16; y++) {
    for (let x = 2; x < 14; x++) grid[y][x] = polo
  }
  // Collar V at row 12-13
  grid[12][7] = poloShd; grid[12][8] = poloShd
  grid[13][7] = poloHi;  grid[13][8] = poloHi
  // Shoulder edges
  for (let y = 12; y < 16; y++) {
    grid[y][2] = poloShd
    grid[y][13] = poloShd
  }
  // Highlight stripe down the chest (gives the polo a defined center placket)
  grid[14][7] = poloHi; grid[14][8] = poloHi

  // ── Neck (row 11) ──────────────────────────────────────────────────
  for (let x = 6; x <= 9; x++) grid[11][x] = skinShd
  grid[11][7] = skin; grid[11][8] = skin

  // ── Face (rows 4-10) ───────────────────────────────────────────────
  for (let y = 4; y <= 10; y++) {
    for (let x = 4; x <= 11; x++) grid[y][x] = skin
  }
  // Face shading on right side
  for (let y = 5; y <= 10; y++) grid[y][11] = skinShd
  grid[4][4] = skinShd; grid[4][11] = skinShd
  grid[10][4] = skinShd

  // ── Eyes (row 7) ───────────────────────────────────────────────────
  grid[7][6] = '#1a1a1a'
  grid[7][9] = '#1a1a1a'

  // ── Eyebrows (row 6) ──────────────────────────────────────────────
  grid[6][6] = darken(hair, 0.1)
  grid[6][9] = darken(hair, 0.1)

  // ── Mouth (row 9) ─────────────────────────────────────────────────
  grid[9][7] = darken(skin, 0.35)
  grid[9][8] = darken(skin, 0.35)

  // ── Hair (rows 2-5) ───────────────────────────────────────────────
  if (hairStyle !== 'bald') {
    // Top crown
    for (let x = 4; x <= 11; x++) {
      if (hairStyle === 'receding' && (x === 5 || x === 10)) continue
      grid[3][x] = hair
    }
    if (hairStyle === 'receding') {
      grid[4][4] = hair; grid[4][11] = hair
    } else {
      for (let x = 3; x <= 12; x++) grid[4][x] = hair
      // Strip top row for buzz cut so it looks shorter
      if (hairStyle === 'buzz') {
        for (let x = 4; x <= 11; x++) grid[3][x] = darken(hair, 0.2)
        grid[2] = grid[2].map(() => null)
      } else {
        // Add the very top row for fuller styles
        for (let x = 5; x <= 10; x++) grid[2][x] = hair
      }
    }
    // Side-part — push hair slightly to the right
    if (hairStyle === 'side-part') {
      grid[3][5] = darken(hair, 0.15)
      grid[4][4] = darken(hair, 0.15)
    }
  } else {
    // Bald — small shadow at top of head
    grid[4][7] = darken(skin, 0.10)
    grid[4][8] = darken(skin, 0.10)
  }

  // ── Facial hair (rows 8-10) ──────────────────────────────────────
  if (facialHair === 'mustache') {
    grid[8][7] = hair; grid[8][8] = hair
  } else if (facialHair === 'goatee') {
    grid[10][7] = hair; grid[10][8] = hair
    grid[11][7] = hair; grid[11][8] = hair
  } else if (facialHair === 'short-beard') {
    grid[9][5] = hair; grid[9][6] = hair; grid[9][9] = hair; grid[9][10] = hair
    grid[10][5] = hair; grid[10][6] = hair; grid[10][7] = hair; grid[10][8] = hair; grid[10][9] = hair; grid[10][10] = hair
  } else if (facialHair === 'full-beard') {
    grid[8][5] = hair; grid[8][10] = hair
    for (let x = 5; x <= 10; x++) grid[9][x] = hair
    for (let x = 4; x <= 11; x++) grid[10][x] = hair
    grid[11][6] = hair; grid[11][7] = hair; grid[11][8] = hair; grid[11][9] = hair
  }

  return grid
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return [128, 128, 128]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
function lighten(hex, amt = 0.2) {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt)
}
function darken(hex, amt = 0.2) {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt))
}
