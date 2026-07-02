/**
 * FieldMini — a compact, ink-light field diagram with fielder dots.
 *
 * Used on the index-card pocket shift cards: just the fan, the diamond, and the
 * 9 fielder dots at their ideal (angle, depth) positions — no chips, no legend,
 * no spray shading. Prints cleanly in black on a mono printer (amber dots read
 * as gray but the position labels carry the meaning).
 *
 * fielders: [{ pos, angle, depth, movable }] — angle -45=LF line, 0=middle,
 * +45=RF line; depth 0=home … 1=OF fence.
 */
export default function FieldMini({ fielders = [], w = 210, h = 176 }) {
  const HOME = { x: w / 2, y: h - 14 }
  const R_OF = h - 30           // outfield fence radius
  const R_INF = R_OF * 0.5      // infield dirt edge
  const HALF = 45

  const pt = (angle, depthFrac) => {
    const r = depthFrac * R_OF
    const a = (angle - 90) * Math.PI / 180
    return [HOME.x + r * Math.cos(a), HOME.y + r * Math.sin(a)]
  }
  const [lfx, lfy] = pt(-HALF, 1)
  const [rfx, rfy] = pt(HALF, 1)
  // Base positions (bag ~ depth of the infield)
  const bag = f => pt(f, R_INF / R_OF * 0.52)
  const [b1x, b1y] = bag(HALF)
  const [b2x, b2y] = pt(0, R_INF / R_OF * 0.55)
  const [b3x, b3y] = bag(-HALF)

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      {/* grass fan */}
      <path d={`M ${HOME.x} ${HOME.y} L ${lfx} ${lfy} A ${R_OF} ${R_OF} 0 0 1 ${rfx} ${rfy} Z`}
        fill="#f4f7f4" stroke="#cbd5e1" strokeWidth="1" />
      {/* infield dirt arc */}
      <path d={`M ${pt(-HALF, R_INF / R_OF)[0]} ${pt(-HALF, R_INF / R_OF)[1]} A ${R_INF} ${R_INF} 0 0 1 ${pt(HALF, R_INF / R_OF)[0]} ${pt(HALF, R_INF / R_OF)[1]}`}
        fill="none" stroke="#e2ceb0" strokeWidth="1.2" />
      {/* foul lines */}
      <line x1={HOME.x} y1={HOME.y} x2={lfx} y2={lfy} stroke="#cbd5e1" strokeWidth="1" />
      <line x1={HOME.x} y1={HOME.y} x2={rfx} y2={rfy} stroke="#cbd5e1" strokeWidth="1" />
      {/* bases */}
      {[[b1x, b1y], [b2x, b2y], [b3x, b3y]].map(([x, y], i) => (
        <rect key={i} x={x - 2.5} y={y - 2.5} width="5" height="5" fill="#fff" stroke="#94a3b8" strokeWidth="1"
          transform={`rotate(45 ${x} ${y})`} />
      ))}
      {/* home */}
      <circle cx={HOME.x} cy={HOME.y} r="2.5" fill="#fff" stroke="#94a3b8" strokeWidth="1" />
      {/* fielder dots */}
      {fielders.map(f => {
        const [x, y] = pt(f.angle, f.depth)
        const mov = f.movable
        return (
          <g key={f.pos}>
            <circle cx={x} cy={y} r={mov ? 8.5 : 6} fill={mov ? '#f59e0b' : '#94a3b8'} stroke="#fff" strokeWidth="1.5" />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
              style={{ fontSize: mov ? '7px' : '6px', fontWeight: 800, fill: '#fff' }}>{f.pos}</text>
          </g>
        )
      })}
    </svg>
  )
}
