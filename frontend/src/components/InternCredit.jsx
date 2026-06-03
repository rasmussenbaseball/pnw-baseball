import { Link } from 'react-router-dom'

// Small "built by an intern" credit line for pages an intern created, with a
// link back to the About team section. Phrasing matches the inline credit on
// the Player Comps page. Style guide: no em-dashes.
//
//   <InternCredit names="Luke Malzewski" />
//   <InternCredit names={['Trevor Kazahaya', 'Connor Broschard']} />
export default function InternCredit({ names, className = '' }) {
  const list = Array.isArray(names) ? names : [names]
  const joined =
    list.length === 2 ? `${list[0]} and ${list[1]}` : list.join(', ')
  const noun = list.length > 1 ? 'interns' : 'intern'
  return (
    <p className={`text-[11px] text-gray-500 dark:text-gray-400 ${className}`}>
      Built by NW Baseball Stats {noun}{' '}
      <span className="font-semibold text-gray-700 dark:text-gray-300">{joined}</span>.{' '}
      <Link to="/about" className="text-nw-teal hover:underline">Meet the team →</Link>
    </p>
  )
}
