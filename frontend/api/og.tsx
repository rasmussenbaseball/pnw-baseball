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

function PlayerCard({ player, latest, isPitcher }) {
  const fullName = `${player.first_name || ''} ${player.last_name || ''}`.trim();
  const team = player.team_name || player.team_short || '';
  const position = player.position || '';
  const klass = player.year_in_school ? `${player.year_in_school}.` : '';
  const headshot = fixUrl(player.headshot_url);
  const logo = fixUrl(player.logo_url);

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

function ArticleCard({ article }) {
  const cover = fixUrl(article.hero_image_url);
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

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        position: 'relative',
        background: TEAL_DARK,
        color: WHITE,
        fontFamily:
          '"Inter", "Helvetica Neue", system-ui, -apple-system, sans-serif',
      }}
    >
      {cover ? (
        <img
          src={cover}
          width={WIDTH}
          height={HEIGHT}
          style={{
            objectFit: 'cover',
            width: WIDTH,
            height: HEIGHT,
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        />
      ) : null}
      {/* Dark gradient overlay for readability */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.45) 50%, rgba(0,0,0,0.92) 100%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: 60,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: 2,
            color: AMBER,
            textTransform: 'uppercase',
          }}
        >
          NW Baseball Stats • Article
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 'auto',
            gap: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: title.length > 60 ? 56 : 68,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -1.5,
              maxWidth: 1100,
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div
              style={{
                display: 'flex',
                fontSize: 26,
                color: 'rgba(255,255,255,0.85)',
                fontWeight: 400,
                lineHeight: 1.3,
                maxWidth: 1100,
              }}
            >
              {subtitle.length > 130 ? subtitle.slice(0, 127) + '…' : subtitle}
            </div>
          ) : null}
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: DIM,
              marginTop: 12,
              gap: 14,
            }}
          >
            <span>By {author}</span>
            {date ? <span>•</span> : null}
            {date ? <span>{date}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Card: team page
// ───────────────────────────────────────────────────────────────

function TeamCard({ team }) {
  const name = team.short_name || team.school_name || 'Team';
  const conf = team.conference_abbrev || team.conference || '';
  const div = team.division_level || team.division_name || '';
  const record =
    team.wins != null && team.losses != null
      ? `${team.wins}-${team.losses}`
      : '';
  const logo = fixUrl(team.logo_url);

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

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const type = (url.searchParams.get('t') || 'default').toLowerCase();
    const id = url.searchParams.get('id');
    const slug = url.searchParams.get('slug');
    const title = url.searchParams.get('title');
    const subtitle = url.searchParams.get('subtitle');
    const kicker = url.searchParams.get('kicker');

    let element;

    if (type === 'player' && id) {
      const data = await safeFetch(`${API_BASE}/players/${id}`);
      if (data && data.player) {
        const player = data.player;
        const batting = data.batting_stats || [];
        const pitching = data.pitching_stats || [];
        const isPitcher =
          (player.position || '').toUpperCase() === 'P' && pitching.length > 0;
        const list = isPitcher ? pitching : batting;
        // Latest season is highest "season" value
        const latest =
          list.length > 0
            ? [...list].sort(
                (a, b) => Number(b.season || 0) - Number(a.season || 0)
              )[0]
            : null;
        element = (
          <PlayerCard player={player} latest={latest} isPitcher={isPitcher} />
        );
      }
    } else if (type === 'article' && slug) {
      const data = await safeFetch(`${API_BASE}/articles/${slug}`);
      if (data) {
        element = <ArticleCard article={data} />;
      }
    } else if (type === 'team' && id) {
      const data = await safeFetch(`${API_BASE}/teams/${id}`);
      if (data) {
        element = <TeamCard team={data} />;
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
      width: WIDTH,
      height: HEIGHT,
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
