// Dynamic Open Graph image generator.
//
// Renders 1200x630 PNGs at the edge using @vercel/og. The middleware
// in frontend/middleware.js rewrites <meta property="og:image"> on
// the SPA shell HTML to point at this endpoint with the right
// template + params. So when a link crawler (iMessage / Slack /
// Twitter / Discord / Facebook) fetches index.html for a route, it
// then fetches a personalized preview image generated here.
//
// Templates supported:
//   default | player | article | team | gm | game | commitments
//
// All data lookups go through api.nwbaseballstats.com so this stays
// stateless and works on Vercel's Edge runtime.
//
// Cache: 24h browser + edge; preview crawlers cache aggressively too.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// ───────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────

const SITE_DOMAIN = 'https://nwbaseballstats.com';
const API_BASE = 'https://api.nwbaseballstats.com/api/v1';

const TEAL_DARK = '#003845';
const TEAL = '#00687a';
const TEAL_LIGHT = '#008ba6';
const AMBER = '#fbbf24';
const WHITE = '#ffffff';
const DIM = 'rgba(255,255,255,0.72)';
const FAINT = 'rgba(255,255,255,0.45)';

const WIDTH = 1200;
const HEIGHT = 630;

// Portrait "trading card" download size (fixed for every player).
const P_W = 1080;
const P_H = 1500;

// New player-profile palette (savant-style cream / navy / maroon / gold),
// matching frontend/src/components/playerProfile/shared.jsx.
const PROFILE = {
  cream: '#faf7f1',
  card: '#ffffff',
  border: '#e5dfd2',
  borderStrong: '#c8bfa8',
  ink: '#1a1a1a',
  muted: '#6b6b6b',
  light: '#9a9a9a',
  track: '#efeadc',
  navy: '#14365c',
  navyLight: '#1f5485',
  maroon: '#d22d49',
  blue: '#5d99c6',
  gold: '#c9a44c',
};
const HERO_GRAD = `linear-gradient(120deg, ${PROFILE.navy} 0%, ${PROFILE.navyLight} 55%, ${PROFILE.gold} 100%)`;

// Savant-style percentile color ramp: deep blue (low) → light blue → DARK
// (middle) → light red → deep red (high). Black/dark is reserved for the
// middle band only; everything else gets a shade of red or blue.
function pctColor(p) {
  if (p == null) return '#9a9a9a';
  if (p >= 90) return '#b01e38';
  if (p >= 73) return '#d2415a';
  if (p >= 58) return '#e08475';
  if (p >= 43) return '#2b2b2b';
  if (p >= 28) return '#7fa8cc';
  if (p >= 11) return '#5d99c6';
  return '#1f5fa8';
}

// Percentile (0-100, higher value = higher) from the endpoint's decile array
// (9 thresholds). higherBetter flips it so "good" is always high.
function decilePct(decArr, v, higherBetter) {
  if (!decArr || !decArr.length || v == null) return null;
  let c = 0;
  for (const t of decArr) if (v >= t) c++;
  let pct = (c / decArr.length) * 100;
  if (!higherBetter) pct = 100 - pct;
  return Math.max(1, Math.min(99, Math.round(pct)));
}

const CACHE_HEADERS = {
  'Cache-Control':
    'public, immutable, no-transform, max-age=86400, s-maxage=86400',
};

// ───────────────────────────────────────────────────────────────
// Shared layout helpers
// ───────────────────────────────────────────────────────────────

function Wordmark({ subtle = false }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        color: subtle ? DIM : WHITE,
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: -0.5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: 8,
          background: AMBER,
          color: TEAL_DARK,
          fontWeight: 900,
          fontSize: 22,
        }}
      >
        NW
      </div>
      <div style={{ display: 'flex' }}>NW Baseball Stats</div>
    </div>
  );
}

function Background({ children, variant = 'default' }) {
  // Variants tweak the gradient color so different page types feel distinct.
  const gradients = {
    default: `linear-gradient(135deg, ${TEAL_DARK} 0%, ${TEAL} 55%, ${TEAL_LIGHT} 100%)`,
    player: `linear-gradient(135deg, #001a25 0%, ${TEAL_DARK} 55%, ${TEAL} 100%)`,
    article: `linear-gradient(180deg, ${TEAL_DARK} 0%, #000 100%)`,
    team: `linear-gradient(135deg, ${TEAL_DARK} 0%, ${TEAL} 100%)`,
    gm: `linear-gradient(135deg, #1a0033 0%, #4a1d96 50%, ${TEAL} 100%)`,
    game: `linear-gradient(135deg, ${TEAL_DARK} 0%, #001a25 100%)`,
  };
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        background: gradients[variant] || gradients.default,
        color: WHITE,
        fontFamily:
          '"Inter", "Helvetica Neue", system-ui, -apple-system, sans-serif',
        padding: 60,
        position: 'relative',
      }}
    >
      {/* Diagonal decorative stripe */}
      <div
        style={{
          position: 'absolute',
          top: -100,
          right: -100,
          width: 400,
          height: 400,
          background: 'rgba(251,191,36,0.08)',
          transform: 'rotate(35deg)',
          display: 'flex',
        }}
      />
      {children}
    </div>
  );
}

function FooterBar({ subtitle }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 'auto',
        paddingTop: 24,
        borderTop: '2px solid rgba(255,255,255,0.15)',
      }}
    >
      <Wordmark />
      {subtitle ? (
        <div
          style={{
            display: 'flex',
            fontSize: 20,
            color: DIM,
            fontWeight: 500,
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Data fetchers
// ───────────────────────────────────────────────────────────────

async function safeFetch(url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 300 } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

function fixUrl(maybeRelative) {
  if (!maybeRelative) return null;
  if (maybeRelative.startsWith('http')) return maybeRelative;
  return `${SITE_DOMAIN}${
    maybeRelative.startsWith('/') ? '' : '/'
  }${maybeRelative}`;
}

function fmt(n, places = 3) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return num.toFixed(places).replace(/^0/, ''); // .321 instead of 0.321
}

function fmtInt(n) {
  if (n === null || n === undefined || n === '') return '—';
  return String(Math.round(Number(n)));
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Build a same-origin URL that proxies an external image through
// /api/img. Satori (the renderer under @vercel/og) doesn't follow
// HTTP redirects reliably on image fetches, so we cannot give it a
// Sidearm-style URL that 302s to a CDN converter. Routing through
// our own proxy lets us resolve redirects server-side and hand
// Satori a clean image response.
//
// Returns null when the raw URL is empty — callers fall through to
// the team logo or initials.
function proxiedImageUrl(rawUrl) {
  if (!rawUrl) return null;
  // For images already on our own domain (team logos in /logos/*,
  // headshots in /headshots/*) skip the proxy and let Satori fetch
  // directly — same-origin, no redirects.
  if (
    rawUrl.startsWith(SITE_DOMAIN + '/logos/') ||
    rawUrl.startsWith(SITE_DOMAIN + '/headshots/')
  ) {
    return rawUrl;
  }
  return `${SITE_DOMAIN}/api/img?url=${encodeURIComponent(rawUrl)}`;
}

// ───────────────────────────────────────────────────────────────
// Card: default (homepage, leaderboards, misc)
// ───────────────────────────────────────────────────────────────

function DefaultCard({ title, subtitle, kicker }) {
  return (
    <Background variant="default">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 'auto',
          marginBottom: 'auto',
          gap: 20,
        }}
      >
        {kicker ? (
          <div
            style={{
              display: 'flex',
              fontSize: 24,
              color: AMBER,
              fontWeight: 600,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            fontSize: 84,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: -2,
            maxWidth: 1000,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              color: DIM,
              maxWidth: 1000,
              lineHeight: 1.3,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      <FooterBar subtitle="nwbaseballstats.com" />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: player
// ───────────────────────────────────────────────────────────────

function PlayerCard({ player, latest, isPitcher, headshotSrc, logoSrc }) {
  const fullName = `${player.first_name || ''} ${player.last_name || ''}`.trim();
  const team = player.team_name || player.team_short || '';
  const position = player.position || '';
  const klass = player.year_in_school ? `${player.year_in_school}.` : '';
  // headshotSrc / logoSrc are pre-resolved data URLs from the handler.
  // Falling through to initials is fine if both are null.
  const headshot = headshotSrc;
  const logo = logoSrc;

  // Stat line varies by player type
  const stats = [];
  if (isPitcher && latest) {
    stats.push({ label: 'ERA', value: fmt(latest.era, 2) });
    stats.push({ label: 'K', value: fmtInt(latest.strikeouts) });
    stats.push({ label: 'IP', value: fmt(latest.innings_pitched, 1) });
    if (latest.war !== null && latest.war !== undefined) {
      stats.push({ label: 'WAR', value: fmt(latest.war, 1) });
    } else if (latest.whip !== null && latest.whip !== undefined) {
      stats.push({ label: 'WHIP', value: fmt(latest.whip, 2) });
    }
  } else if (latest) {
    stats.push({ label: 'AVG', value: fmt(latest.avg, 3) });
    stats.push({ label: 'HR', value: fmtInt(latest.home_runs ?? latest.hr) });
    stats.push({ label: 'RBI', value: fmtInt(latest.rbi) });
    if (latest.war !== null && latest.war !== undefined) {
      stats.push({ label: 'WAR', value: fmt(latest.war, 1) });
    } else if (latest.ops !== null && latest.ops !== undefined) {
      stats.push({ label: 'OPS', value: fmt(latest.ops, 3) });
    }
  }

  return (
    <Background variant="player">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          marginTop: 24,
          gap: 40,
          alignItems: 'center',
          flex: 1,
        }}
      >
        {/* Avatar block: headshot if available, else team logo */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 280,
            height: 320,
            background: 'rgba(255,255,255,0.06)',
            border: '4px solid rgba(255,255,255,0.18)',
            borderRadius: 24,
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {headshot ? (
            <img
              src={headshot}
              width={280}
              height={320}
              style={{ objectFit: 'cover', width: 280, height: 320 }}
            />
          ) : logo ? (
            <img
              src={logo}
              width={200}
              height={200}
              style={{ objectFit: 'contain' }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                fontSize: 90,
                fontWeight: 900,
                color: AMBER,
              }}
            >
              {(player.first_name || '?')[0]}
              {(player.last_name || '?')[0]}
            </div>
          )}
        </div>

        {/* Right side: name + team + stats */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            gap: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 72,
              fontWeight: 800,
              letterSpacing: -2,
              lineHeight: 1,
            }}
          >
            {fullName || 'Player'}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 30,
              color: DIM,
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {team ? <span>{team}</span> : null}
            {team && (position || klass) ? <span>•</span> : null}
            {position ? <span>{position}</span> : null}
            {klass ? <span>{klass}</span> : null}
            {latest?.season ? (
              <>
                <span>•</span>
                <span>{latest.season}</span>
              </>
            ) : null}
          </div>

          {/* Stat strip */}
          {stats.length > 0 ? (
            <div
              style={{
                display: 'flex',
                gap: 24,
                marginTop: 24,
              }}
            >
              {stats.map((s) => (
                <div
                  key={s.label}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: 14,
                    padding: '16px 22px',
                    minWidth: 110,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      fontSize: 16,
                      color: AMBER,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                    }}
                  >
                    {s.label}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      fontSize: 48,
                      fontWeight: 800,
                      lineHeight: 1.1,
                    }}
                  >
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <FooterBar subtitle={team ? `${team} • Player Profile` : 'Player Profile'} />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: article
// ───────────────────────────────────────────────────────────────

function ArticleCard({ article, coverSrc }) {
  // coverSrc is a pre-resolved data URL from the handler; fall
  // through to the raw URL only if the pre-fetch failed (Satori
  // might be able to render it for simple cases).
  const cover = coverSrc || fixUrl(article.hero_image_url);
  const title = article.title || 'NW Baseball Stats Article';
  const subtitle = article.subtitle || '';
  const author = article.author_name || 'NWBB';
  const date = article.published_at
    ? new Date(article.published_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  // Satori (the renderer under @vercel/og) does NOT reliably handle
  // `position: absolute` with `inset: 0` for full-bleed images.
  // So this layout is a pure flex column: cover on top, dark text
  // block on bottom.
  const COVER_H = 360;
  const TEXT_H = HEIGHT - COVER_H; // 270

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        background: TEAL_DARK,
        color: WHITE,
        fontFamily:
          '"Inter", "Helvetica Neue", system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Cover image strip on top */}
      <div
        style={{
          display: 'flex',
          width: WIDTH,
          height: COVER_H,
          position: 'relative',
          overflow: 'hidden',
          background: TEAL_DARK,
        }}
      >
        {cover ? (
          <img
            src={cover}
            width={WIDTH}
            height={COVER_H}
            style={{
              width: WIDTH,
              height: COVER_H,
              objectFit: 'cover',
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              width: WIDTH,
              height: COVER_H,
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${TEAL_DARK} 0%, ${TEAL} 100%)`,
              fontSize: 32,
              color: DIM,
              fontWeight: 600,
            }}
          >
            NW Baseball Stats
          </div>
        )}
      </div>

      {/* Dark text block below */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: WIDTH,
          height: TEXT_H,
          background:
            'linear-gradient(180deg, #001a25 0%, #000 100%)',
          padding: '32px 60px',
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 2.5,
            color: AMBER,
            textTransform: 'uppercase',
          }}
        >
          NW Baseball Stats • Article
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: title.length > 60 ? 42 : 52,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: -1.5,
            maxWidth: 1080,
          }}
        >
          {title.length > 110 ? title.slice(0, 107) + '…' : title}
        </div>
        {subtitle ? (
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: 'rgba(255,255,255,0.78)',
              fontWeight: 400,
              lineHeight: 1.3,
              maxWidth: 1080,
            }}
          >
            {subtitle.length > 110 ? subtitle.slice(0, 107) + '…' : subtitle}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            fontSize: 20,
            color: DIM,
            marginTop: 'auto',
            gap: 14,
          }}
          >
            <span>By {author}</span>
            {date ? <span>•</span> : null}
            {date ? <span>{date}</span> : null}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: team page
// ───────────────────────────────────────────────────────────────

function TeamCard({ team, logoSrc }) {
  const name = team.short_name || team.school_name || 'Team';
  const conf = team.conference_abbrev || team.conference || '';
  const div = team.division_level || team.division_name || '';
  const record =
    team.wins != null && team.losses != null
      ? `${team.wins}-${team.losses}`
      : '';
  const logo = logoSrc;

  return (
    <Background variant="team">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 60,
          flex: 1,
          marginTop: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 280,
            height: 280,
            background: 'rgba(255,255,255,0.95)',
            borderRadius: 24,
            padding: 30,
            flexShrink: 0,
          }}
        >
          {logo ? (
            <img
              src={logo}
              width={220}
              height={220}
              style={{ objectFit: 'contain' }}
            />
          ) : (
            <div style={{ display: 'flex', fontSize: 60, color: TEAL_DARK }}>
              {name[0]}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 80,
              fontWeight: 800,
              letterSpacing: -2,
              lineHeight: 1,
            }}
          >
            {name}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 30,
              color: DIM,
              gap: 14,
              alignItems: 'center',
            }}
          >
            {[div, conf].filter(Boolean).join(' • ')}
          </div>
          {record ? (
            <div
              style={{
                display: 'flex',
                marginTop: 20,
                gap: 18,
                alignItems: 'baseline',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  fontSize: 22,
                  color: AMBER,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  textTransform: 'uppercase',
                }}
              >
                Record
              </div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 56,
                  fontWeight: 800,
                }}
              >
                {record}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <FooterBar subtitle="Team Profile" />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: NW Coaching Simulator (/gm)
// ───────────────────────────────────────────────────────────────

function GmCard() {
  return (
    <Background variant="gm">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 'auto',
          marginBottom: 'auto',
          gap: 24,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 26,
            color: AMBER,
            fontWeight: 700,
            letterSpacing: 2.5,
            textTransform: 'uppercase',
          }}
        >
          New • Premium feature
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 100,
            fontWeight: 900,
            lineHeight: 0.95,
            letterSpacing: -3,
            maxWidth: 1100,
          }}
        >
          NW Coaching Simulator
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 30,
            color: DIM,
            lineHeight: 1.3,
            maxWidth: 1000,
          }}
        >
          Build your dynasty. Recruit. Manage budgets. Win championships.
        </div>
      </div>
      <FooterBar subtitle="nwbaseballstats.com/gm" />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: commitments tracker
// ───────────────────────────────────────────────────────────────

function CommitmentsCard() {
  return (
    <Background variant="default">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 'auto',
          marginBottom: 'auto',
          gap: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 24,
            color: AMBER,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          Recruiting
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 100,
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: -3,
          }}
        >
          Commitments Tracker
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 28,
            color: DIM,
            lineHeight: 1.3,
            maxWidth: 1000,
          }}
        >
          Every committed JUCO and high school player headed to a Northwest college.
        </div>
      </div>
      <FooterBar subtitle="Updated daily" />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: game recap (lightweight — name only since not all games have data)
// ───────────────────────────────────────────────────────────────

function GameCard({ game }) {
  const away = game.away_team || 'Away';
  const home = game.home_team || 'Home';
  const aScore = game.away_score;
  const hScore = game.home_score;
  const final = game.status === 'final' || (aScore != null && hScore != null);
  const date = game.game_date
    ? new Date(game.game_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  return (
    <Background variant="game">
      <Wordmark />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 'auto',
          marginBottom: 'auto',
          gap: 20,
          alignItems: 'center',
          width: '100%',
        }}
      >
        {final ? (
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: AMBER,
              fontWeight: 800,
              letterSpacing: 4,
              textTransform: 'uppercase',
            }}
          >
            Final
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 50,
            justifyContent: 'center',
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 38,
                fontWeight: 700,
                maxWidth: 350,
              }}
            >
              {away}
            </div>
            {aScore != null ? (
              <div
                style={{
                  display: 'flex',
                  fontSize: 130,
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                {aScore}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 50,
              color: DIM,
              fontWeight: 700,
            }}
          >
            @
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 38,
                fontWeight: 700,
                maxWidth: 350,
              }}
            >
              {home}
            </div>
            {hScore != null ? (
              <div
                style={{
                  display: 'flex',
                  fontSize: 130,
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                {hScore}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <FooterBar subtitle={date || 'Game'} />
    </Background>
  );
}

// ───────────────────────────────────────────────────────────────
// Handler
// ───────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────
// Portrait download card (fixed 1080x1350 for every player)
//
// Designed so EVERY zone is always filled regardless of how much data a
// player has: optional sections (awards, multi-season career) fall back to
// computed content (season strengths, career totals) so the card is never
// half-empty and is always the same size.
// ───────────────────────────────────────────────────────────────

function PFmt(key, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'avg' || key === 'obp' || key === 'slg' || key === 'ops' ||
      key === 'woba' || key === 'iso' || key === 'babip')
    return fmt(v, 3);
  if (key === 'era' || key === 'whip' || key === 'fip' || key === 'xfip' ||
      key === 'siera')
    return fmt(v, 2);
  if (key === 'war') return Number(v).toFixed(1); // keep leading 0 (0.6, -0.4)
  if (key === 'ip' || key === 'num1') return fmt(v, 1);
  if (key === 'pct') return fmt(Number(v) * (Number(v) <= 1 ? 100 : 1), 1) + '%';
  if (key === 'pct100') return fmt(v, 1) + '%';
  return fmtInt(v);
}

function StatCell({ label, value, accent }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', fontSize: 19, color: PROFILE.muted, fontWeight: 600, letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', fontSize: 34, fontWeight: 800, color: accent || PROFILE.ink }}>
        {value}
      </div>
    </div>
  );
}

function StatRow({ cells, top }) {
  return (
    <div
      style={{
        display: 'flex',
        background: PROFILE.card,
        border: `2px solid ${PROFILE.border}`,
        borderRadius: 16,
        marginTop: top ? 0 : 12,
        padding: '16px 8px',
      }}
    >
      {cells.map((c, i) => (
        <StatCell key={i} label={c.label} value={c.value} accent={c.accent} />
      ))}
    </div>
  );
}

function Panel({ title, w, h, children, note }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: w,
        height: h,
        background: PROFILE.card,
        border: `2px solid ${PROFILE.border}`,
        borderRadius: 18,
        padding: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontSize: 20,
          fontWeight: 800,
          color: PROFILE.navy,
          letterSpacing: 1,
          textTransform: 'uppercase',
          marginBottom: 14,
        }}
      >
        {title}
      </div>
      {children}
      {note ? (
        <div style={{ display: 'flex', marginTop: 'auto', fontSize: 14, color: PROFILE.light }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function PBar({ label, value, pct }) {
  const c = pctColor(pct);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 38 }}>
      <div style={{ display: 'flex', width: 92, justifyContent: 'flex-end', fontSize: 20, fontWeight: 700, color: PROFILE.ink }}>
        {label}
      </div>
      <div style={{ display: 'flex', flex: 1, height: 18, background: PROFILE.track, borderRadius: 9, position: 'relative' }}>
        <div style={{ display: 'flex', width: `${Math.max(3, Math.min(100, pct || 0))}%`, height: 18, background: c, borderRadius: 9 }} />
      </div>
      <div
        style={{
          display: 'flex',
          width: 44,
          height: 44,
          borderRadius: 22,
          background: c,
          color: '#fff',
          fontSize: 20,
          fontWeight: 800,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {pct != null ? Math.round(pct) : '—'}
      </div>
      <div style={{ display: 'flex', width: 72, justifyContent: 'flex-end', fontSize: 19, fontWeight: 700, color: PROFILE.muted }}>
        {value}
      </div>
    </div>
  );
}

function StackBar({ segments }) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', width: '100%', height: 34, borderRadius: 8, overflow: 'hidden' }}>
        {segments.map((s, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              width: `${(s.value / total) * 100}%`,
              height: 34,
              background: s.color,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 18, color: PROFILE.ink }}>
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 4, background: s.color }} />
            <div style={{ display: 'flex', fontWeight: 700 }}>{s.label}</div>
            <div style={{ display: 'flex', color: PROFILE.muted }}>
              {Math.round((s.value / total) * 100)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStatGrid({ cells }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
      {cells.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '33.3%',
            height: 84,
            gap: 5,
          }}
        >
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 800, color: c.pctl != null ? pctColor(c.pctl) : (c.color || PROFILE.ink) }}>{c.value}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', fontSize: 16, color: PROFILE.muted, fontWeight: 600 }}>{c.label}</div>
            {c.pctl != null ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 26, height: 19, padding: '0 5px', borderRadius: 6, background: pctColor(c.pctl), color: '#fff', fontSize: 13, fontWeight: 800 }}>
                {c.pctl}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function LabeledBar({ label, pct, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32 }}>
      <div style={{ display: 'flex', width: 64, fontSize: 18, fontWeight: 700, color: PROFILE.ink }}>{label}</div>
      <div style={{ display: 'flex', flex: 1, height: 16, background: PROFILE.track, borderRadius: 8 }}>
        <div style={{ display: 'flex', width: `${Math.max(2, Math.min(100, pct || 0))}%`, height: 16, background: color, borderRadius: 8 }} />
      </div>
      <div style={{ display: 'flex', width: 56, justifyContent: 'flex-end', fontSize: 18, fontWeight: 700, color: PROFILE.muted }}>
        {pct != null ? Math.round(pct) + '%' : '—'}
      </div>
    </div>
  );
}

function SplitRow({ label, value, accent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, borderBottom: `1px solid ${PROFILE.track}` }}>
      <div style={{ display: 'flex', fontSize: 19, color: PROFILE.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', fontSize: 22, fontWeight: 800, color: accent || PROFILE.ink }}>{value}</div>
    </div>
  );
}

// Stylized spray field: a fan (home plate + foul lines + outfield arc) split
// into pull / center / oppo wedges, each shaded by how often the batter hits
// the ball that way. Pull side flips with handedness.
function SprayField({ pull, center, oppo, gb, fb, ld, bats }) {
  const cx = 158, cy = 150, R = 134;
  const pt = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [cx + R * Math.sin(r), cy - R * Math.cos(r)];
  };
  const B = [-45, -15, 15, 45].map(pt);
  const wedge = (p1, p2) =>
    `M ${cx} ${cy} L ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A ${R} ${R} 0 0 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z`;
  // Each direction gets its own hue, opacity scaled by how often the ball goes there.
  const rgba = (rgb, f) => `rgba(${rgb},${(0.3 + Math.min(0.65, (f || 0) * 1.5)).toFixed(2)})`;
  const COL = { pull: '210,45,73', center: '201,164,76', oppo: '93,153,198' };
  const rhh = (bats || 'R').toUpperCase().startsWith('R'); // RHH pulls to left field
  const leftDir = rhh ? 'pull' : 'oppo';
  const rightDir = rhh ? 'oppo' : 'pull';
  const fracOf = { pull, center, oppo };
  const lbl = (f) => (f != null ? Math.round(f * 100) + '%' : '—');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
      <svg width={300} height={160} viewBox="0 0 316 160">
        <path d={wedge(B[0], B[1])} fill={rgba(COL[leftDir], fracOf[leftDir])} />
        <path d={wedge(B[1], B[2])} fill={rgba(COL.center, center)} />
        <path d={wedge(B[2], B[3])} fill={rgba(COL[rightDir], fracOf[rightDir])} />
        <path d={`M ${cx} ${cy} L ${B[0][0].toFixed(1)} ${B[0][1].toFixed(1)} A ${R} ${R} 0 0 1 ${B[3][0].toFixed(1)} ${B[3][1].toFixed(1)} Z`} fill="none" stroke="#14365c" strokeWidth="2.5" />
        <line x1={cx} y1={cy} x2={B[1][0].toFixed(1)} y2={B[1][1].toFixed(1)} stroke="#14365c" strokeWidth="1" />
        <line x1={cx} y1={cy} x2={B[2][0].toFixed(1)} y2={B[2][1].toFixed(1)} stroke="#14365c" strokeWidth="1" />
        <circle cx={cx} cy={cy} r="4.5" fill="#14365c" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: 6 }}>
        {(() => {
          const D = { pull: ['Pull', pull, COL.pull], center: ['Center', center, COL.center], oppo: ['Oppo', oppo, COL.oppo] };
          // Labels follow the wedges left-to-right so a lefty's Pull sits under the right wedge.
          return [D[leftDir], D.center, D[rightDir]];
        })().map(([k, v, rgb], i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, gap: 2 }}>
            <div style={{ display: 'flex', fontSize: 22, fontWeight: 800, color: `rgb(${rgb})` }}>{lbl(v)}</div>
            <div style={{ display: 'flex', fontSize: 15, color: PROFILE.muted, fontWeight: 600 }}>{k}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', marginTop: 8, fontSize: 15, color: PROFILE.muted }}>
        {`GB ${lbl(gb)} · LD ${lbl(ld)} · FB ${lbl(fb)}`}
      </div>
    </div>
  );
}

// Cumulative season trajectory from game logs: OPS (hitter) / ERA (pitcher).
// Fills the empty space for players with only 1-2 career seasons.
function buildTrend(gl, isPitcher) {
  if (!gl) return null;
  const ipReal = (ip) => { const w = Math.floor(ip); return w + Math.round((ip - w) * 10) / 3; };
  if (isPitcher) {
    const rows = (gl.pitching || []).filter((r) => r.ip != null)
      .sort((a, b) => (a.game_date || '').localeCompare(b.game_date || ''));
    let er = 0, outs = 0; const pts = [];
    for (const r of rows) { er += r.er || 0; outs += Math.round(ipReal(r.ip || 0) * 3); if (outs > 0) pts.push((9 * er) / (outs / 3)); }
    return pts.length >= 6 ? { label: 'ERA', points: pts } : null;
  }
  const rows = (gl.batting || []).filter((r) => (r.ab || 0) + (r.bb || 0) > 0)
    .sort((a, b) => (a.game_date || '').localeCompare(b.game_date || ''));
  let ab = 0, h = 0, bb = 0, hbp = 0, sf = 0, tb = 0; const pts = [];
  for (const r of rows) {
    ab += r.ab || 0; h += r.h || 0; bb += r.bb || 0; hbp += r.hbp || 0; sf += r.sf || 0;
    tb += (r.h || 0) + (r['2b'] || 0) + 2 * (r['3b'] || 0) + 3 * (r.hr || 0);
    const pa = ab + bb + hbp + sf;
    if (ab > 0 && pa > 0) pts.push((h + bb + hbp) / pa + tb / ab);
  }
  return pts.length >= 6 ? { label: 'OPS', points: pts } : null;
}

function TrendChart({ trend, w, h }) {
  const pts = trend.points, n = pts.length;
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const padX = 8, padY = 12;
  const X = (i) => padX + (i / (n - 1)) * (w - 2 * padX);
  const Y = (v) => padY + (1 - (v - min) / range) * (h - 2 * padY);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill="none" stroke={PROFILE.maroon} strokeWidth="3" />
      <circle cx={X(n - 1).toFixed(1)} cy={Y(pts[n - 1]).toFixed(1)} r="4.5" fill={PROFILE.maroon} />
    </svg>
  );
}

function PortraitCard({
  player, isPitcher, latest, seasons, summerSeasons, percentiles, headshotSrc, logoSrc,
  awards, careerRankings, pnwRankings, goldGloves, levelLabel, pbp, trend,
}) {
  const fullName = `${player.first_name || ''} ${player.last_name || ''}`.trim();
  const team = player.team_name || player.team_short || '';
  const pos = (player.position || (isPitcher ? 'P' : '')).toUpperCase();
  const klass = player.year_in_school ? `${player.year_in_school}` : '';
  const bt = [player.bats, player.throws].filter(Boolean).join('/');

  // ── Stat lines ──
  const L = latest || {};
  const coreCells = isPitcher
    ? [
        { label: 'G', value: fmtInt(L.games) },
        { label: 'GS', value: fmtInt(L.games_started) },
        { label: 'IP', value: PFmt('ip', L.innings_pitched) },
        { label: 'W', value: fmtInt(L.wins) },
        { label: 'L', value: fmtInt(L.losses) },
        { label: 'SV', value: fmtInt(L.saves) },
        { label: 'K', value: fmtInt(L.strikeouts) },
        { label: 'BB', value: fmtInt(L.walks) },
      ]
    : [
        { label: 'G', value: fmtInt(L.games) },
        { label: 'PA', value: fmtInt(L.plate_appearances) },
        { label: 'H', value: fmtInt(L.hits) },
        { label: 'HR', value: fmtInt(L.home_runs) },
        { label: 'RBI', value: fmtInt(L.rbi) },
        { label: 'SB', value: fmtInt(L.stolen_bases) },
        { label: 'R', value: fmtInt(L.runs) },
        { label: 'BB', value: fmtInt(L.walks) },
      ];
  const advCells = isPitcher
    ? [
        { label: 'ERA', value: PFmt('era', L.era), accent: PROFILE.navy },
        { label: 'WHIP', value: PFmt('whip', L.whip) },
        { label: 'FIP', value: PFmt('fip', L.fip) },
        { label: 'xFIP', value: PFmt('xfip', L.xfip) },
        { label: 'SIERA', value: PFmt('siera', L.siera) },
        { label: 'K/9', value: PFmt('num1', L.k_per_9) },
        { label: 'BB/9', value: PFmt('num1', L.bb_per_9) },
        { label: 'WAR', value: PFmt('war', L.pitching_war), accent: PROFILE.maroon },
      ]
    : [
        { label: 'AVG', value: PFmt('avg', L.batting_avg), accent: PROFILE.navy },
        { label: 'OBP', value: PFmt('obp', L.on_base_pct) },
        { label: 'SLG', value: PFmt('slg', L.slugging_pct) },
        { label: 'OPS', value: PFmt('ops', L.ops) },
        { label: 'wOBA', value: PFmt('woba', L.woba) },
        { label: 'wRC+', value: fmtInt(L.wrc_plus) },
        { label: 'ISO', value: PFmt('iso', L.iso) },
        { label: 'WAR', value: PFmt('war', L.offensive_war), accent: PROFILE.maroon },
      ];

  // ── Percentile bars ──
  const pctMetrics = isPitcher
    ? [
        { key: 'pitching_war', label: 'WAR', value: PFmt('war', L.pitching_war) },
        { key: 'fip', label: 'FIP', value: PFmt('fip', L.fip) },
        { key: 'k_pct', label: 'K%', value: PFmt('pct', L.k_pct) },
        { key: 'bb_pct', label: 'BB%', value: PFmt('pct', L.bb_pct) },
        { key: 'baa', label: 'BAA', value: PFmt('avg', L.baa) },
        { key: 'hr_pa_pct', label: 'HR/PA', value: L.batters_faced ? PFmt('avg', (L.home_runs_allowed || 0) / L.batters_faced) : '—' },
      ]
    : [
        { key: 'woba', label: 'wOBA', value: PFmt('woba', L.woba) },
        { key: 'wrc_plus', label: 'wRC+', value: fmtInt(L.wrc_plus) },
        { key: 'iso', label: 'ISO', value: PFmt('iso', L.iso) },
        { key: 'bb_pct', label: 'BB%', value: PFmt('pct', L.bb_pct) },
        { key: 'k_pct', label: 'K%', value: PFmt('pct', L.k_pct) },
        { key: 'offensive_war', label: 'WAR', value: PFmt('war', L.offensive_war) },
      ];
  const getPct = (k) => {
    const p = percentiles[k];
    return p == null ? null : (typeof p === 'object' ? p.percentile : p);
  };
  const bars = pctMetrics.map((m) => ({
    label: m.label,
    pct: getPct(m.key),
    value: m.value,
  }));
  // No-percentile seasons (summer, or pre-PBP years) show a plain season-stats
  // grid in place of the percentile bars, so the card stays the same size.
  const hasPctBars = bars.some((b) => b.pct != null);
  const rateCells = isPitcher
    ? [
        { label: 'ERA', value: PFmt('era', L.era) },
        { label: 'WHIP', value: PFmt('whip', L.whip) },
        { label: 'FIP', value: PFmt('fip', L.fip) },
        { label: 'K/9', value: L.k_per_9 != null ? Number(L.k_per_9).toFixed(1) : '—' },
        { label: 'BB/9', value: L.bb_per_9 != null ? Number(L.bb_per_9).toFixed(1) : '—' },
        { label: 'BAA', value: PFmt('avg', L.baa) },
      ]
    : [
        { label: 'AVG', value: PFmt('avg', L.batting_avg) },
        { label: 'OBP', value: PFmt('obp', L.on_base_pct) },
        { label: 'SLG', value: PFmt('slg', L.slugging_pct) },
        { label: 'OPS', value: PFmt('ops', L.ops) },
        { label: 'wOBA', value: PFmt('woba', L.woba) },
        { label: 'wRC+', value: fmtInt(L.wrc_plus) },
      ];

  // ── Reaching base (hitter) / outcomes (pitcher) stacked bar ──
  let stack;
  if (isPitcher) {
    const k = L.strikeouts || 0, bb = (L.walks || 0) + (L.hit_batters || 0),
      h = L.hits_allowed || 0,
      bf = L.batters_faced || (k + bb + h + 1),
      outs = Math.max(0, bf - k - bb - h);
    stack = [
      { label: 'K', value: k, color: PROFILE.maroon },
      { label: 'Out', value: outs, color: PROFILE.navy },
      { label: 'Hit', value: h, color: PROFILE.gold },
      { label: 'BB/HBP', value: bb, color: PROFILE.blue },
    ];
  } else {
    const hr = L.home_runs || 0, d = L.doubles || 0, t = L.triples || 0,
      h = L.hits || 0, singles = Math.max(0, h - d - t - hr),
      bb = L.walks || 0, hbp = L.hit_by_pitch || 0;
    stack = [
      { label: '1B', value: singles, color: '#2f9e6f' },
      { label: '2B', value: d, color: PROFILE.gold },
      { label: '3B', value: t, color: '#e07a6a' },
      { label: 'HR', value: hr, color: PROFILE.maroon },
      { label: 'BB', value: bb, color: PROFILE.blue },
      { label: 'HBP', value: hbp, color: PROFILE.navyLight },
    ].filter((s) => s.value > 0);
  }

  // ── PBP-derived panels (discipline / batted-ball / splits / clutch) ──
  const disc = pbp && pbp.discipline ? pbp.discipline : null;
  const contact =
    pbp && pbp.contact_profile && (pbp.contact_profile.bb_total || pbp.contact_profile.gb_pct != null)
      ? pbp.contact_profile : null;
  const oppContact =
    pbp && pbp.opp_contact_profile && pbp.opp_contact_profile.gb_pct != null
      ? pbp.opp_contact_profile : null;
  // Spray wedges need pull/center/oppo direction (spring PBP has it; summer/pitchers don't).
  // Without direction but with GB/FB/LD, show a batted-ball panel instead of the spray fan.
  const canSpray = !isPitcher && contact && contact.pull_pct != null;
  const battedOnly = !isPitcher && contact && contact.pull_pct == null;
  const pct1 = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const findSplit = (arr, keys) => {
    if (!arr) return null;
    for (const k of keys) {
      const f = arr.find(
        (s) => s.filter_key === k || (s.label || '').toLowerCase() === k
      );
      if (f) return f;
    }
    return null;
  };

  // Direction-aware percentile (vs the endpoint's deciles) drives the color
  // ramp + a small percentile readout on each discipline stat.
  const dec = disc && disc.deciles ? disc.deciles : {};
  const dP = (decKey, v, higherBetter) => decilePct(dec[decKey], v, higherBetter);
  const twoK = ((pbp && pbp.count_states) || []).find(
    (c) => (c.label || '').toLowerCase().includes('2-strike')
  );
  const twoKpctl = twoK && twoK.deciles ? decilePct(twoK.deciles.contact_pct, twoK.contact_pct, true) : null;
  const airPull = contact ? contact.air_pull_pct : null;

  const discCells = disc
    ? isPitcher
      ? [
          { label: 'Strike%', value: pct1(disc.strike_pct), pctl: dP('strike_pct', disc.strike_pct, true) },
          { label: '1st-K%', value: pct1(disc.first_pitch_strike_pct), pctl: dP('first_pitch_strike_pct', disc.first_pitch_strike_pct, true) },
          { label: 'Whiff%', value: pct1(disc.whiff_pct), pctl: dP('whiff_pct', disc.whiff_pct, true) },
          { label: 'Called-K%', value: pct1(disc.called_strike_pct), pctl: dP('called_strike_pct', disc.called_strike_pct, true) },
          { label: 'Putaway%', value: pct1(disc.putaway_pct), pctl: dP('putaway_pct', disc.putaway_pct, true) },
          { label: 'P/PA', value: disc.pitches_per_pa != null ? disc.pitches_per_pa.toFixed(2) : '—', pctl: null },
        ]
      : [
          { label: 'Swing%', value: pct1(disc.swing_pct), pctl: null },
          { label: 'Contact%', value: pct1(disc.contact_pct), pctl: dP('contact_pct', disc.contact_pct, true) },
          { label: '2K-Contact%', value: twoK ? pct1(twoK.contact_pct) : '—', pctl: twoKpctl },
          { label: 'Putaway%', value: pct1(disc.putaway_pct), pctl: dP('putaway_pct', disc.putaway_pct, false) },
          { label: 'P/PA', value: disc.pitches_per_pa != null ? disc.pitches_per_pa.toFixed(2) : '—', pctl: dP('pitches_per_pa', disc.pitches_per_pa, true) },
          { label: 'Air-Pull%', value: airPull != null ? pct1(airPull) : '—', pctl: dP('air_pull_pct', airPull, true) },
        ]
    : isPitcher
      ? [
          { label: 'K/9', value: L.k_per_9 != null ? Number(L.k_per_9).toFixed(1) : '—' },
          { label: 'BB/9', value: L.bb_per_9 != null ? Number(L.bb_per_9).toFixed(1) : '—' },
          { label: 'HR/9', value: L.hr_per_9 != null ? Number(L.hr_per_9).toFixed(1) : '—' },
          { label: 'LOB%', value: L.lob_pct != null ? Math.round(L.lob_pct * 100) + '%' : '—' },
          { label: 'BABIP', value: PFmt('babip', L.babip_against) },
          { label: 'FIP-', value: fmtInt(L.era_minus) },
        ]
      : [
          { label: 'BB%', value: L.bb_pct != null ? (L.bb_pct * 100).toFixed(1) + '%' : '—' },
          { label: 'K%', value: L.k_pct != null ? (L.k_pct * 100).toFixed(1) + '%' : '—' },
          { label: 'BABIP', value: PFmt('babip', L.babip) },
          { label: 'ISO', value: PFmt('iso', L.iso) },
          { label: 'OPS', value: PFmt('ops', L.ops) },
          { label: 'wRC+', value: fmtInt(L.wrc_plus) },
        ];

  const battedBars = contact
    ? [
        { label: 'GB', pct: contact.gb_pct * 100, color: PROFILE.navy },
        { label: 'LD', pct: contact.ld_pct * 100, color: PROFILE.maroon },
        { label: 'FB', pct: contact.fb_pct * 100, color: PROFILE.navyLight },
        { label: 'Pull', pct: contact.pull_pct * 100, color: PROFILE.gold },
        { label: 'Oppo', pct: contact.oppo_pct * 100, color: PROFILE.blue },
      ]
    : null;

  const vsL = findSplit(pbp && pbp.lr_splits, ['vs_lhp', 'vs_lhb', 'vs lhp', 'vs lhb']);
  const vsR = findSplit(pbp && pbp.lr_splits, ['vs_rhp', 'vs_rhb', 'vs rhp', 'vs rhb']);
  const risp = findSplit(pbp && pbp.situational_splits, ['risp']);
  // Pitchers expose opponent slash as opp_ops (ops is null for them).
  const oVal = (s) => (s == null ? null : isPitcher ? s.opp_ops : s.ops);
  const splitColor = (ops) => {
    if (ops == null) return PROFILE.ink;
    let p = ((ops - 0.5) / 0.55) * 100; // .500→0, 1.05→100
    p = Math.max(1, Math.min(99, p));
    if (isPitcher) p = 100 - p; // low opponent OPS = good
    return pctColor(p);
  };
  const splitRows = [];
  if (vsL) splitRows.push({ label: isPitcher ? 'vs LHB' : 'vs LHP', value: PFmt('ops', oVal(vsL)), accent: splitColor(oVal(vsL)) });
  if (vsR) splitRows.push({ label: isPitcher ? 'vs RHB' : 'vs RHP', value: PFmt('ops', oVal(vsR)), accent: splitColor(oVal(vsR)) });
  if (risp) splitRows.push({ label: 'RISP', value: PFmt('ops', oVal(risp)), accent: splitColor(oVal(risp)) });
  if (disc) {
    const w = disc.total_wpa;
    splitRows.push({
      label: 'WPA',
      value: (w >= 0 ? '+' : '') + fmt(w, 2),
      accent: w >= 0.3 ? '#b01e38' : w >= 0 ? '#d2415a' : w >= -0.3 ? '#7fa8cc' : '#1f5fa8',
    });
    splitRows.push({ label: 'Avg LI', value: fmt(disc.avg_li, 2) });
  }
  // Fallback so the panel is never empty
  if (splitRows.length < 3) {
    splitRows.length = 0;
    if (isPitcher) {
      splitRows.push({ label: 'WHIP', value: PFmt('whip', L.whip) });
      splitRows.push({ label: 'K/9', value: L.k_per_9 != null ? Number(L.k_per_9).toFixed(1) : '—' });
      splitRows.push({ label: 'BB/9', value: L.bb_per_9 != null ? Number(L.bb_per_9).toFixed(1) : '—' });
      splitRows.push({ label: 'HR/9', value: L.hr_per_9 != null ? Number(L.hr_per_9).toFixed(1) : '—' });
    } else {
      splitRows.push({ label: 'OBP', value: PFmt('obp', L.on_base_pct) });
      splitRows.push({ label: 'SLG', value: PFmt('slg', L.slugging_pct) });
      splitRows.push({ label: 'BABIP', value: PFmt('babip', L.babip) });
      splitRows.push({ label: 'wRC+', value: fmtInt(L.wrc_plus), accent: PROFILE.maroon });
    }
  }

  // ── Career rows: spring + summer, newest first ──
  const sortedSeasons = [
    ...(seasons || []).map((s) => ({ ...s, _summer: false })),
    ...(summerSeasons || []).map((s) => ({ ...s, _summer: true, _tag: s.league_abbrev || 'WCL' })),
  ].sort((a, b) => Number(b.season || 0) - Number(a.season || 0)).slice(0, 6);
  // Short careers (<=2 seasons) get a season-trajectory chart to fill the space.
  const showTrend = !!(trend && trend.points && trend.points.length >= 6 && sortedSeasons.length <= 2);
  // Rows shrink to always fit the fixed career box (content height ≈ panel − title/padding).
  const careerContentH = showTrend ? 96 : 200;
  const careerRowH = Math.min(46, Math.floor(careerContentH / Math.max(1, sortedSeasons.length)));
  const careerLineFs = careerRowH >= 42 ? 19 : careerRowH >= 36 ? 17 : 15;
  const careerYrFs = careerRowH >= 42 ? 22 : 19;

  // ── Accolades with fallback to computed "season strengths" ──
  const accolades = [];
  (goldGloves || []).slice(0, 3).forEach((g) =>
    accolades.push({ text: `${String(g.season).slice(2)} ${g.scope} GG${g.mvp ? ' MVP' : ''}`, kind: 'gold' })
  );
  (pnwRankings || []).slice(0, 3).forEach((r) =>
    accolades.push({ text: `${ordinal(r.rank)} PNW · ${r.category}`, kind: 'pnw' })
  );
  (careerRankings || []).slice(0, 3).forEach((r) =>
    accolades.push({ text: `${ordinal(r.rank)} ${player.team_short || 'team'} · ${r.category}`, kind: 'career' })
  );
  (awards || []).slice(0, 3).forEach((a) =>
    accolades.push({ text: `${String(a.season).slice(2)} ${a.category} leader`, kind: 'award' })
  );
  // Fallback: if thin, fill with top percentile "strengths"
  if (accolades.length < 4) {
    const strengths = bars
      .filter((b) => b.pct != null && b.pct >= 60)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 4 - accolades.length)
      .map((b) => ({ text: `${ordinal(Math.round(b.pct))} pct · ${b.label}`, kind: 'strength' }));
    accolades.push(...strengths);
  }
  const accColor = { gold: '#fef3c7', pnw: '#dbeafe', career: '#fde9ee', award: '#e7f0e3', strength: '#eef1f6' };
  const accText = { gold: '#92400e', pnw: '#1e40af', career: '#9b1c34', award: '#2f6b2a', strength: '#3a4a63' };

  return (
    <div style={{ width: P_W, height: P_H, display: 'flex', flexDirection: 'column', background: PROFILE.cream, fontFamily: '"Inter","Helvetica Neue",system-ui,sans-serif' }}>
      {/* HERO */}
      <div style={{ display: 'flex', height: 250, background: HERO_GRAD, padding: 36, alignItems: 'center', gap: 28 }}>
        <div style={{ display: 'flex', width: 168, height: 168, borderRadius: 20, background: 'rgba(255,255,255,0.12)', border: '4px solid rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {headshotSrc ? (
            <img src={headshotSrc} width={168} height={168} style={{ objectFit: 'cover', width: 168, height: 168 }} />
          ) : (
            <div style={{ display: 'flex', fontSize: 64, fontWeight: 900, color: '#fff' }}>
              {(player.first_name || '?')[0]}{(player.last_name || '?')[0]}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 8 }}>
          <div style={{ display: 'flex', fontSize: 62, fontWeight: 900, color: '#fff', lineHeight: 1, letterSpacing: -1.5 }}>
            {fullName || 'Player'}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 26, color: 'rgba(255,255,255,0.9)', alignItems: 'center' }}>
            {[pos, player.jersey_number ? `#${player.jersey_number}` : '', bt, klass].filter(Boolean).join('  ·  ')}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 800, color: PROFILE.gold, marginTop: 2 }}>
            {team}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', width: 110, height: 110, borderRadius: 16, background: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
            {logoSrc ? (
              <img src={logoSrc} width={86} height={86} style={{ objectFit: 'contain' }} />
            ) : (
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 900, color: PROFILE.navy }}>{(team || '?')[0]}</div>
            )}
          </div>
          <div style={{ display: 'flex', background: PROFILE.gold, color: PROFILE.navy, fontSize: 20, fontWeight: 800, padding: '5px 14px', borderRadius: 10, letterSpacing: 1 }}>
            {levelLabel}
          </div>
        </div>
      </div>

      {/* BODY */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '24px 36px 0', gap: 14 }}>
        <StatRow cells={coreCells} top />
        <StatRow cells={advCells} />

        {/* mid row: percentiles | batted-ball (hitter) or stack */}
        <div style={{ display: 'flex', gap: 14, height: 340 }}>
          <Panel
            title={hasPctBars ? 'Percentile Rankings' : 'Season Stats'}
            w={612}
            h={340}
            note={hasPctBars ? `vs ${levelLabel} · ${L.season || ''}` : `${L.season || ''} season`}
          >
            {hasPctBars ? (
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flex: 1 }}>
                {bars.map((b, i) => (
                  <PBar key={i} label={b.label} value={b.value} pct={b.pct} />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                <MiniStatGrid cells={rateCells} />
              </div>
            )}
          </Panel>
          {canSpray ? (
            <Panel title="Spray Chart" w={356} h={340}>
              <SprayField
                pull={contact.pull_pct} center={contact.center_pct} oppo={contact.oppo_pct}
                gb={contact.gb_pct} fb={contact.fb_pct} ld={contact.ld_pct}
                bats={player.bats}
              />
            </Panel>
          ) : battedOnly ? (
            <Panel title="Batted Ball" w={356} h={340}>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <LabeledBar label="GB" pct={contact.gb_pct * 100} color={PROFILE.navy} />
                <LabeledBar label="LD" pct={contact.ld_pct * 100} color={PROFILE.maroon} />
                <LabeledBar label="FB" pct={contact.fb_pct * 100} color={PROFILE.navyLight} />
                <div style={{ display: 'flex', height: 1, background: PROFILE.track, margin: '16px 0 8px' }} />
                <MiniStatGrid cells={[
                  { label: 'AVG', value: PFmt('avg', L.batting_avg) },
                  { label: 'ISO', value: PFmt('iso', L.iso) },
                  { label: 'BABIP', value: PFmt('babip', L.babip) },
                ]} />
              </div>
            </Panel>
          ) : isPitcher && oppContact ? (
            <Panel title="Opponent Contact" w={356} h={340}>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <LabeledBar label="GB" pct={oppContact.gb_pct * 100} color={PROFILE.navy} />
                <LabeledBar label="LD" pct={oppContact.ld_pct * 100} color={PROFILE.maroon} />
                <LabeledBar label="FB" pct={oppContact.fb_pct * 100} color={PROFILE.navyLight} />
                <div style={{ display: 'flex', height: 1, background: PROFILE.track, margin: '16px 0 8px' }} />
                <MiniStatGrid cells={[
                  { label: 'Opp BA', value: PFmt('avg', L.baa), pctl: getPct('baa') },
                  { label: 'BABIP', value: PFmt('babip', L.babip_against), pctl: null },
                  { label: 'HR/9', value: L.hr_per_9 != null ? Number(L.hr_per_9).toFixed(1) : '—', pctl: getPct('hr_per_9') },
                ]} />
              </div>
            </Panel>
          ) : (
            <Panel title={isPitcher ? 'Batters Faced' : 'How They Reach Base'} w={356} h={340}>
              <StackBar segments={stack} />
            </Panel>
          )}
        </div>

        {/* pbp row: discipline | splits & clutch */}
        <div style={{ display: 'flex', gap: 14, height: 300 }}>
          <Panel
            title={isPitcher ? 'Command & Misses' : 'Plate Discipline'}
            w={612}
            h={300}
            note={disc ? 'play-by-play (tracked PA)' : 'season rates'}
          >
            <MiniStatGrid cells={discCells} />
          </Panel>
          <Panel
            title={(vsL || vsR || risp) ? 'Splits & Clutch' : 'Rates'}
            w={356}
            h={300}
            note={(vsL || vsR || risp) ? 'L/R + RISP shown as OPS' : null}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {splitRows.map((r, i) => (
                <SplitRow key={i} label={r.label} value={r.value} accent={r.accent} />
              ))}
            </div>
          </Panel>
        </div>

        {/* career row: career (+ trend chart for short careers) | accolades */}
        <div style={{ display: 'flex', gap: 14, height: 280 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 612 }}>
          <Panel title="Career" w={612} h={showTrend ? 150 : 280}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1 }}>
              {sortedSeasons.map((s, i) => {
                const logo = s.logo_url || s.team_logo;
                const line = isPitcher
                  ? (s._summer
                      ? `${fmtInt(s.games)} G · ${PFmt('era', s.era)} ERA · ${fmtInt(s.strikeouts)} K`
                      : `${fmtInt(s.games)} G · ${PFmt('era', s.era)} ERA · ${fmtInt(s.strikeouts)} K · ${PFmt('war', s.pitching_war)} WAR`)
                  : (s._summer
                      ? `${fmtInt(s.games)} G · ${PFmt('avg', s.batting_avg)} · ${fmtInt(s.home_runs)} HR · ${fmtInt(s.rbi)} RBI`
                      : `${fmtInt(s.games)} G · ${PFmt('avg', s.batting_avg)} · ${fmtInt(s.home_runs)} HR · ${fmtInt(s.rbi)} RBI · ${PFmt('war', s.offensive_war)} WAR`);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, height: careerRowH, borderBottom: i < sortedSeasons.length - 1 ? `1px solid ${PROFILE.track}` : 'none' }}>
                    <div style={{ display: 'flex', width: 48, fontSize: careerYrFs, fontWeight: 800, color: PROFILE.navy }}>{`'${String(s.season).slice(2)}`}</div>
                    <div style={{ display: 'flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
                      {logo ? (
                        <img src={proxiedImageUrl(fixUrl(logo))} width={24} height={24} style={{ objectFit: 'contain' }} />
                      ) : null}
                    </div>
                    {s._summer ? (
                      <div style={{ display: 'flex', background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 800, padding: '2px 6px', borderRadius: 5 }}>
                        {s._tag}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', flex: 1, fontSize: careerLineFs, color: PROFILE.ink }}>{line}</div>
                  </div>
                );
              })}
            </div>
          </Panel>
          {showTrend ? (
            <Panel title={`${trend.label} trend · ${L.season || ''}`} w={612} h={116}>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' }}>
                <TrendChart trend={trend} w={566} h={66} />
              </div>
            </Panel>
          ) : null}
          </div>
          <Panel title={accolades.some((a) => a.kind !== 'strength') ? 'Accolades' : 'Season Strengths'} w={356} h={280}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {accolades.slice(0, 4).map((a, i) => (
                <div key={i} style={{ display: 'flex', background: accColor[a.kind], color: accText[a.kind], fontSize: 18, fontWeight: 700, padding: '8px 12px', borderRadius: 10 }}>
                  {a.text}
                </div>
              ))}
            </div>
          </Panel>
        </div>

        {/* footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 56, marginTop: 'auto' }}>
          <div style={{ display: 'flex', fontSize: 22, fontWeight: 800, color: PROFILE.navy }}>nwbaseballstats.com</div>
          <div style={{ display: 'flex', fontSize: 20, color: PROFILE.muted }}>{L.season ? `${L.season} season` : ''}</div>
        </div>
      </div>
    </div>
  );
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const type = (url.searchParams.get('t') || 'default').toLowerCase();
    const id = url.searchParams.get('id');
    const slug = url.searchParams.get('slug');
    const title = url.searchParams.get('title');
    const subtitle = url.searchParams.get('subtitle');
    const kicker = url.searchParams.get('kicker');
    const format = (url.searchParams.get('format') || '').toLowerCase();

    let element;
    let imgW = WIDTH;
    let imgH = HEIGHT;

    if (type === 'player' && id) {
      const data = await safeFetch(`${API_BASE}/players/${id}`);
      if (data && data.player) {
        const player = data.player;
        const batting = data.batting_stats || [];
        const pitching = data.pitching_stats || [];
        // Position is free-text ("P", "RHP", "LHP", ...). Treat as a pitcher
        // when there's pitching data and either no batting data or a pitcher
        // position — otherwise a pure pitcher (RHP, no batting rows) wrongly
        // rendered as an all-blank hitter.
        const posUp = (player.position || '').toUpperCase();
        const posPitcher = ['P', 'RHP', 'LHP', 'SP', 'RP'].includes(posUp);
        const isPitcher =
          pitching.length > 0 && (batting.length === 0 || posPitcher);
        const list = isPitcher ? pitching : batting;
        // Latest season is highest "season" value
        const latest =
          list.length > 0
            ? [...list].sort(
                (a, b) => Number(b.season || 0) - Number(a.season || 0)
              )[0]
            : null;
        // Route every external image through our /api/img proxy so
        // Satori sees a stable same-origin URL with no redirects.
        const headshotSrc = proxiedImageUrl(fixUrl(player.headshot_url));
        const logoSrc = proxiedImageUrl(fixUrl(player.logo_url));

        if (format === 'portrait') {
          imgW = P_W; imgH = P_H;
          const levelLabel = player.division_level || player.division_name || 'PNW';
          const seasonParam = url.searchParams.get('season');
          const kind = (url.searchParams.get('kind') || 'spring').toLowerCase();
          const summerList = isPitcher ? (data.summer_pitching || []) : (data.summer_batting || []);

          let selected = latest;
          let pbp = null;
          let trend = null;
          let percentiles = isPitcher ? (data.pitching_percentiles || {}) : (data.batting_percentiles || {});

          if (kind === 'summer') {
            // Summer season: stats-only (no PBP / percentiles) → Season Stats fallback.
            selected = (seasonParam ? summerList.find((r) => String(r.season) === seasonParam) : summerList[0]) || latest;
            percentiles = {};
          } else {
            if (seasonParam) {
              const found = list.find((r) => String(r.season) === seasonParam);
              if (found) selected = found;
            }
            // Season-correct percentiles when not the latest season.
            if (selected && latest && selected.season !== latest.season) {
              const d2 = await safeFetch(`${API_BASE}/players/${id}?percentile_season=${selected.season}`);
              if (d2) percentiles = isPitcher ? (d2.pitching_percentiles || {}) : (d2.batting_percentiles || {});
            }
            if (selected && selected.season) {
              const pbpUrl = isPitcher
                ? `${API_BASE}/players/${id}/pitch-level-stats-pitcher?season=${selected.season}`
                : `${API_BASE}/players/${id}/pitch-level-stats?season=${selected.season}`;
              pbp = await safeFetch(pbpUrl);
              const gl = await safeFetch(`${API_BASE}/players/${id}/gamelogs?season=${selected.season}`);
              trend = buildTrend(gl, isPitcher);
            }
          }
          element = (
            <PortraitCard
              player={player}
              isPitcher={isPitcher}
              latest={selected}
              seasons={list}
              summerSeasons={summerList}
              percentiles={percentiles}
              headshotSrc={headshotSrc}
              logoSrc={logoSrc}
              awards={(data.awards || []).filter((a) =>
                isPitcher ? a.type === 'pitching' : a.type === 'batting'
              )}
              careerRankings={(data.career_rankings || []).filter((r) =>
                isPitcher ? r.type === 'pitching' : r.type === 'batting'
              )}
              pnwRankings={(data.pnw_rankings || []).filter((r) =>
                isPitcher ? r.type === 'pitching' : r.type === 'batting'
              )}
              goldGloves={data.gold_gloves || []}
              levelLabel={levelLabel}
              pbp={pbp}
              trend={trend}
            />
          );
        } else {
          element = (
            <PlayerCard
              player={player}
              latest={latest}
              isPitcher={isPitcher}
              headshotSrc={headshotSrc}
              logoSrc={logoSrc}
            />
          );
        }
      }
    } else if (type === 'summerplayer' && id) {
      // Summer-only player card (WCL etc.): no PBP, percentiles vs summer-league
      // peers when present, summer seasons in the career box.
      const seasonParam = url.searchParams.get('season');
      const data = await safeFetch(
        `${API_BASE}/summer/players/${id}${seasonParam ? `?season=${seasonParam}` : ''}`
      );
      if (data && data.player) {
        const p = data.player;
        const batting = data.batting || [];
        const pitching = data.pitching || [];
        const posUp = (p.position || '').toUpperCase();
        const posPitcher = ['P', 'RHP', 'LHP', 'SP', 'RP'].includes(posUp);
        const isPitcher = pitching.length > 0 && (batting.length === 0 || posPitcher);
        const list = isPitcher ? pitching : batting;
        let selected = list.length
          ? [...list].sort((a, b) => Number(b.season || 0) - Number(a.season || 0))[0]
          : null;
        if (seasonParam) {
          const f = list.find((r) => String(r.season) === seasonParam);
          if (f) selected = f;
        }
        const lvl = p.league_abbr || 'WCL';
        const cardPlayer = {
          ...p,
          team_name: p.team_name,
          logo_url: p.team_logo,
          position: posUp, // summer feed stores lowercase ("cf") → uppercase to "CF"
          division_level: lvl,
        };
        // Summer has PBP too (discipline, L/R splits, leverage) — fetch it so the
        // card shows splits/clutch/batted-ball instead of "How They Reach Base".
        let pbp = null;
        if (selected && selected.season) {
          const pbpUrl = isPitcher
            ? `${API_BASE}/summer/players/${id}/pitch-level-stats-pitcher?season=${selected.season}`
            : `${API_BASE}/summer/players/${id}/pitch-level-stats?season=${selected.season}`;
          pbp = await safeFetch(pbpUrl);
        }
        // Summer season rows carry no logo of their own; stamp the team logo so the
        // career box shows it on every row.
        const seasonRows = list.map((r) => ({ ...r, team_logo: r.team_logo || p.team_logo, logo_url: r.logo_url || p.team_logo }));
        imgW = P_W; imgH = P_H;
        element = (
            <PortraitCard
              player={cardPlayer}
              isPitcher={isPitcher}
              latest={selected}
              seasons={seasonRows}
              summerSeasons={[]}
              percentiles={isPitcher ? (data.pitching_percentiles || {}) : (data.batting_percentiles || {})}
              headshotSrc={proxiedImageUrl(fixUrl(p.headshot_url))}
              logoSrc={proxiedImageUrl(fixUrl(p.team_logo))}
              awards={[]}
              careerRankings={[]}
              pnwRankings={[]}
              goldGloves={[]}
              levelLabel={lvl}
              pbp={pbp}
            />
          );
      }
    } else if (type === 'article' && slug) {
      const data = await safeFetch(`${API_BASE}/articles/${slug}`);
      if (data) {
        const coverSrc = proxiedImageUrl(fixUrl(data.hero_image_url));
        element = <ArticleCard article={data} coverSrc={coverSrc} />;
      }
    } else if (type === 'team' && id) {
      const data = await safeFetch(`${API_BASE}/teams/${id}`);
      if (data) {
        const logoSrc = proxiedImageUrl(fixUrl(data.logo_url));
        element = <TeamCard team={data} logoSrc={logoSrc} />;
      }
    } else if (type === 'gm') {
      element = <GmCard />;
    } else if (type === 'commitments') {
      element = <CommitmentsCard />;
    } else if (type === 'game' && id) {
      const data = await safeFetch(`${API_BASE}/games/${id}`);
      if (data) {
        element = <GameCard game={data} />;
      }
    } else if (type === 'custom') {
      element = (
        <DefaultCard
          title={title || 'NW Baseball Stats'}
          subtitle={
            subtitle ||
            'Advanced Stats for Northwest College Baseball'
          }
          kicker={kicker}
        />
      );
    }

    // Fallbacks: default site card for missing data or unknown type
    if (!element) {
      element = (
        <DefaultCard
          title={title || 'NW Baseball Stats'}
          subtitle={
            subtitle ||
            'WAR, wOBA, FIP, play-by-play, and WPA across NCAA D1, D2, D3, NAIA, and NWAC.'
          }
          kicker={kicker || 'Pacific Northwest'}
        />
      );
    }

    return new ImageResponse(element, {
      width: imgW,
      height: imgH,
      headers: CACHE_HEADERS,
    });
  } catch (e) {
    // Last-ditch: return a tiny error card so social cards always work
    return new ImageResponse(
      (
        <DefaultCard
          title="NW Baseball Stats"
          subtitle="Northwest College Baseball Analytics"
        />
      ),
      { width: WIDTH, height: HEIGHT, headers: CACHE_HEADERS }
    );
  }
}
