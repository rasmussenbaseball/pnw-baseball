/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Brand colors
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
      },
      fontFamily: {
        'display': ['"HK Modular"', 'system-ui', 'sans-serif'],
        'sans': ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
