/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // 'class' strategy means dark mode toggles when the <html> element
  // has class="dark" applied. ThemeContext writes that class based on
  // the user's saved preference (Light / Dark / System).
  darkMode: 'class',
  theme: {
    extend: {
      // Add an `xs` breakpoint between Tailwind defaults of base (mobile)
      // and `sm` (640px). 480px covers the gap where iPhone-class phones
      // in landscape transition out of the smallest layouts.
      screens: {
        'xs': '480px',
      },
      colors: {
        // Main-site brand (teal / cream)
        'nw-teal': '#00687a',
        'nw-teal-dark': '#004d5a',
        'nw-teal-light': '#008a9e',
        'nw-brown': '#3d2500',
        'nw-brown-light': '#5c3a0a',
        'nw-cream': '#faf8f5',
        'nw-white': '#ffffff',
        // Functional aliases — read CSS variables when set by the GM
        // theming layer (lib/teamTheme.js) so the entire GM experience
        // picks up the user's school colors. Fall back to NW teal when
        // no team theme is applied (main site, login, etc.).
        'pnw-green':    'var(--team-primary, #00687a)',
        'pnw-green-fg': 'var(--team-primary-fg, #FFFFFF)',
        'pnw-forest':   'var(--team-primary-dim, #004d5a)',
        'pnw-sky':      'var(--team-secondary, #008a9e)',
        'pnw-sky-fg':   'var(--team-secondary-fg, #1a1a2e)',
        'pnw-slate':    'var(--team-primary-dim, #00687a)',
        'pnw-teal':     'var(--team-secondary, #008a9e)',
        'pnw-cream':    '#faf8f5',
        // Accent — auto-picks whichever of the team's two colors makes
        // a better "highlight" (avoids using white or near-black as
        // an accent since they read flat in a UI).
        'team-accent':  'var(--team-accent, #FFD200)',
        'team-accent-fg': 'var(--team-accent-fg, #1a1a2e)',

        // Coach & Scouting Portal palette — deep indigo / antique gold.
        // Hex values estimated from the reference logos; tweak in this
        // one place if any color reads slightly off in production.
        'portal-purple':       '#1d1f4d',  // primary dark indigo (header, nav)
        'portal-purple-light': '#2c2f6b',  // hover / secondary surfaces
        'portal-purple-dark':  '#13153a',  // deepest, for shadows / hover-pressed
        'portal-dark':         '#0a0d1c',  // near-black accent (text, dividers)
        'portal-accent':       '#8e7553',  // antique gold / brown (links, badges)
        'portal-accent-light': '#a89070',  // brighter gold for hover
        'portal-cream':        '#f5f3ef',  // off-white text on dark backgrounds
      },
      fontFamily: {
        'display': ['"HK Modular"', 'system-ui', 'sans-serif'],
        'sans': ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        // Portal-wide typeface — clean modern sans, distinct from
        // Inter without feeling weird. Applied via PortalLayout to
        // every page inside the Coach & Scouting Portal.
        'portal': ['Outfit', 'system-ui', '-apple-system', 'sans-serif'],
        // GM dynasty game — pixelated retro aesthetic. VT323 is the body
        // font (readable monospaced pixel), Press Start 2P is the chunky
        // 8-bit display font for headers + nav.
        'pixel': ['"VT323"', '"Courier New"', 'monospace'],
        'pixel-display': ['"Press Start 2P"', '"Courier New"', 'monospace'],
      },
    },
  },
  plugins: [],
}
