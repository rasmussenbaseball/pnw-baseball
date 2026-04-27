/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Main-site brand (teal / cream)
        'nw-teal': '#00687a',
        'nw-teal-dark': '#004d5a',
        'nw-teal-light': '#008a9e',
        'nw-brown': '#3d2500',
        'nw-brown-light': '#5c3a0a',
        'nw-cream': '#faf8f5',
        'nw-white': '#ffffff',
        // Functional aliases
        'pnw-green': '#00687a',    // teal replaces old green
        'pnw-forest': '#004d5a',   // darker teal
        'pnw-sky': '#008a9e',      // lighter teal for links/accents
        'pnw-slate': '#00687a',    // header background
        'pnw-cream': '#faf8f5',

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
      },
    },
  },
  plugins: [],
}
