// Vercel Edge Middleware — personalized link previews.
//
// React SPAs ship one index.html, so link crawlers (iMessage, Slack,
// Twitter, Discord, Facebook, etc.) only ever see the static og:*
// tags baked in at build time. This middleware intercepts every
// page request, fetches the SPA shell, and rewrites og:image (plus
// og:title and og:description) to match the actual page being
// shared.
//
// The og:image URL points at our edge function /api/og?t=...&id=...,
// which generates the personalized PNG on demand.
//
// Performance: middleware only does string replace + one static
// fetch per page. No backend calls in the hot path. The data fetch
// for personalized images happens only when the crawler then
// requests the og:image URL (and is cached for 24h on subsequent
// hits).

export const config = {
  // Run on all paths EXCEPT:
  //   /api/*       — Vercel functions (og generator + rewrite to backend)
  //   /assets/*    — Vite-built JS/CSS bundles
  //   /images/*    — static images in /public
  //   /logos/*     — team logos
  //   /headshots/* — player headshots
  //   /icons/*     — favicons etc.
  //   /fonts/*     — webfonts
  //   *.ext        — files with an extension (e.g. robots.txt, favicon.ico)
  matcher: [
    '/((?!api/|assets/|images/|logos/|headshots/|icons/|fonts/|.*\\.[\\w]+$).*)',
  ],
};

const SITE = 'https://nwbaseballstats.com';
const API = 'https://api.nwbaseballstats.com/api/v1';

// ────────────────────────────────────────────────────────────────
// Route → OG params resolver
//
// Given a request URL, decide which `/api/og` parameters describe
// it. Returns { ogParams, title, description }.
//
// Keep this list in sync with frontend/src/App.jsx routes.
// ────────────────────────────────────────────────────────────────

function resolveRoute(pathname) {
  // Player page → /player/:playerId
  const playerMatch = pathname.match(/^\/player\/(\d+)\/?$/);
  if (playerMatch) {
    return {
      ogParams: `t=player&id=${playerMatch[1]}`,
      title: 'Player Profile · NW Baseball Stats',
      description:
        'Full stats, splits, percentiles, spray chart, and play-by-play breakdowns for this Northwest college baseball player.',
      seo: { type: 'player', id: playerMatch[1] },
    };
  }

  // GM player detail → /gm/player/:playerId — leave as default GM
  if (/^\/gm\/player\/\d+/.test(pathname)) {
    return {
      ogParams: 't=gm',
      title: 'NW Coaching Simulator · NW Baseball Stats',
      description:
        'Build your dynasty. Recruit. Manage budgets. Win championships. Premium feature on NW Baseball Stats.',
    };
  }

  // Article → /news/:slug (but not /news or /news/commitments)
  const articleMatch = pathname.match(/^\/news\/([^/]+)\/?$/);
  if (articleMatch && articleMatch[1] !== 'commitments') {
    const slug = encodeURIComponent(articleMatch[1]);
    return {
      ogParams: `t=article&slug=${slug}`,
      title: 'NW Baseball Stats · Article',
      description:
        'Read the latest article on Northwest college baseball — recruiting, results, analytics, and trends.',
    };
  }

  // Commitments tracker
  if (/^\/news\/commitments\/?$/.test(pathname)) {
    return {
      ogParams: 't=commitments',
      title: 'Commitments Tracker · NW Baseball Stats',
      description:
        'Every committed JUCO and high school player headed to a Northwest college program.',
    };
  }

  // Team page → /team/:teamId
  const teamMatch = pathname.match(/^\/team\/(\d+)\/?$/);
  if (teamMatch) {
    return {
      ogParams: `t=team&id=${teamMatch[1]}`,
      title: 'Team Profile · NW Baseball Stats',
      description:
        'Roster, season stats, schedule, and advanced ratings for this Northwest college baseball program.',
      seo: { type: 'team', id: teamMatch[1] },
    };
  }

  // Conference page → /conference/:slug (slug = lowercased abbreviation)
  const confMatch = pathname.match(/^\/conference\/([a-z0-9-]+)\/?$/i);
  if (confMatch) {
    return {
      ogParams: 't=default',
      title: 'Conference Baseball — Standings & Stats · NW Baseball Stats',
      description:
        'Standings, team and player stats, and schedule for this Northwest college baseball conference.',
      seo: { type: 'conference', id: confMatch[1].toLowerCase() },
    };
  }

  // Game / boxscore → /game/:gameId
  const gameMatch = pathname.match(/^\/game\/(\d+)\/?$/);
  if (gameMatch) {
    return {
      ogParams: `t=game&id=${gameMatch[1]}`,
      title: 'Game Box Score · NW Baseball Stats',
      description:
        'Box score, play-by-play, win probability chart, and game-level stats.',
    };
  }

  // Coaching sim (GM) landing + sub-pages
  if (pathname === '/gm' || /^\/gm\//.test(pathname)) {
    return {
      ogParams: 't=gm',
      title: 'NW Coaching Simulator · NW Baseball Stats',
      description:
        'Build your dynasty. Recruit. Manage budgets. Win championships. Premium feature on NW Baseball Stats.',
    };
  }

  // Curated static pages — custom title/description
  const staticRoutes = {
    '/': {
      kicker: 'Pacific Northwest',
      title: 'NW Baseball Stats',
      subtitle:
        'Advanced stats and analytics for NCAA D1, D2, D3, NAIA, and NWAC baseball.',
      pageTitle: 'NW Baseball Stats — Northwest College Baseball Analytics',
      pageDesc:
        'WAR, wOBA, FIP, xFIP, play-by-play, and WPA across NCAA D1, D2, D3, NAIA, and NWAC programs in WA, OR, ID, MT.',
    },
    '/hitting': {
      kicker: 'Leaderboards',
      title: 'Hitting Leaders',
      subtitle: 'Top batters by AVG, OPS, wRC+, WAR, and more.',
      pageTitle: 'Hitting Leaderboard · NW Baseball Stats',
      pageDesc:
        'Top batters across Northwest college baseball, ranked by AVG, OPS, wRC+, WAR, and more.',
    },
    '/pitching': {
      kicker: 'Leaderboards',
      title: 'Pitching Leaders',
      subtitle: 'Top arms by ERA, FIP, K%, WAR, and more.',
      pageTitle: 'Pitching Leaderboard · NW Baseball Stats',
      pageDesc:
        'Top pitchers across Northwest college baseball, ranked by ERA, FIP, K%, WAR, and more.',
    },
    '/war': {
      kicker: 'Leaderboards',
      title: 'WAR Leaders',
      subtitle: 'The most valuable players in Northwest college baseball.',
      pageTitle: 'WAR Leaderboard · NW Baseball Stats',
      pageDesc:
        'Wins Above Replacement leaders across NCAA D1, D2, D3, NAIA, and NWAC.',
    },
    '/scoreboard': {
      kicker: 'Today',
      title: 'Scoreboard',
      subtitle: 'Live and final scores from every Northwest college game.',
      pageTitle: 'Scoreboard · NW Baseball Stats',
      pageDesc:
        'Live and final scores from every Northwest college baseball game today.',
    },
    '/teams': {
      kicker: 'Programs',
      title: 'All Teams',
      subtitle: '57+ Northwest programs across five competitive tiers.',
      pageTitle: 'Teams · NW Baseball Stats',
      pageDesc:
        'Every Northwest college baseball program — D1 through NWAC, with rosters, records, and rankings.',
    },
    '/standings': {
      kicker: 'Conferences',
      title: 'Standings',
      subtitle: 'Conference records, win streaks, and playoff seeding.',
      pageTitle: 'Standings · NW Baseball Stats',
      pageDesc: 'Conference standings across every Northwest college league.',
    },
    '/news': {
      kicker: 'News',
      title: 'Latest Articles',
      subtitle: 'Recruiting, results, analytics, and trends.',
      pageTitle: 'News · NW Baseball Stats',
      pageDesc:
        'Articles on Northwest college baseball — recruiting, season recaps, and analytics deep-dives.',
    },
    '/pricing': {
      kicker: 'Subscriptions',
      title: 'Pricing',
      subtitle: 'Free, Premium, and Coach & Scout tiers.',
      pageTitle: 'Subscriptions · NW Baseball Stats',
      pageDesc:
        'Free, Premium, and Coach & Scout subscription tiers for Northwest college baseball analytics.',
    },
    '/about': {
      kicker: 'About',
      title: 'About NW Baseball Stats',
      subtitle: 'How the site is built, what it tracks, and who runs it.',
      pageTitle: 'About · NW Baseball Stats',
      pageDesc:
        'How NW Baseball Stats is built, what it tracks, and the team behind it.',
    },
    '/national-rankings': {
      kicker: 'National',
      title: 'National Rankings',
      subtitle: 'Pear Ratings and Massey Ratings, combined and cross-division.',
      pageTitle: 'National Rankings · NW Baseball Stats',
      pageDesc:
        'Cross-division power ratings from Pear and Massey, side-by-side.',
    },
    '/team-ratings': {
      kicker: 'Power Index',
      title: 'Team Ratings',
      subtitle: 'PNW Power Index — adjusted team strength.',
      pageTitle: 'Team Ratings · NW Baseball Stats',
      pageDesc:
        'PNW Power Index — schedule-strength-adjusted ratings for every Northwest team.',
    },
    '/percentiles': {
      kicker: 'Stats',
      title: 'Player Percentiles',
      subtitle: 'Savant-style percentile bars for hitters and pitchers.',
      pageTitle: 'Percentiles · NW Baseball Stats',
      pageDesc:
        'Statcast-style percentile rankings across every Northwest college baseball player.',
    },
    '/playoff-projections': {
      kicker: 'Projections',
      title: 'Playoff Projections',
      subtitle: 'Monte Carlo simulations of every conference race.',
      pageTitle: 'Playoff Projections · NW Baseball Stats',
      pageDesc:
        'Monte Carlo playoff probabilities, conference titles, and championship odds.',
    },
    '/scatter': {
      kicker: 'Visualizations',
      title: 'Custom Scatter Plot',
      subtitle: 'Plot any stat against any other stat.',
      pageTitle: 'Scatter Plot · NW Baseball Stats',
      pageDesc:
        'Custom scatter visualizations across Northwest college baseball.',
    },
    '/stat-leaders': {
      kicker: 'Leaderboards',
      title: 'Stat Leaders',
      subtitle: 'Top performer in every stat, at a glance.',
      pageTitle: 'Stat Leaders · NW Baseball Stats',
      pageDesc:
        'The single top performer in every traditional and advanced stat.',
    },
    '/records': {
      kicker: 'Records',
      title: 'Single-Season Records',
      subtitle: 'The all-time best stat lines on record.',
      pageTitle: 'Records · NW Baseball Stats',
      pageDesc: 'All-time single-season records across Northwest college baseball.',
    },
    '/team-history': {
      kicker: 'History',
      title: 'Program History',
      subtitle: 'Year-by-year records, conference titles, and tournament runs.',
      pageTitle: 'Team History · NW Baseball Stats',
      pageDesc:
        'Year-by-year program history for every Northwest college baseball team.',
    },
    '/draft': {
      kicker: 'The Game',
      title: '56-0',
      subtitle: 'Draft the best roster in the Pacific Northwest. Can you go a perfect 56-0?',
      pageTitle: '56-0 · The PNW Draft Game',
      pageDesc:
        'Spin a team, draft a player, build the best roster in Northwest college baseball. Chase a perfect 56-0 season.',
    },
    '/draftboard': {
      kicker: 'MLB Draft',
      title: 'Draft Board',
      subtitle: 'Northwest college prospects on every MLB draft board.',
      pageTitle: 'Draft Board · NW Baseball Stats',
      pageDesc:
        'Northwest college baseball prospects tracked across every MLB draft cycle.',
    },
    '/relievers': {
      kicker: 'Leaderboards',
      title: 'Reliever Leaders',
      subtitle: 'Goose Eggs, bullpen WPA, holds, and shutdown relief.',
      pageTitle: 'Relievers · NW Baseball Stats',
      pageDesc:
        'Bullpen leaders across Northwest college baseball — Goose Eggs, holds, WPA, and more.',
    },
    '/fielding': {
      kicker: 'Leaderboards',
      title: 'Fielding Leaders',
      subtitle: 'Defensive leaderboards, filterable by position.',
      pageTitle: 'Fielding · NW Baseball Stats',
      pageDesc:
        'Defensive leaderboards across Northwest college baseball, filterable by position.',
    },
    '/team-stats': {
      kicker: 'Teams',
      title: 'Team Stats',
      subtitle: 'Team-level hitting and pitching across every program.',
      pageTitle: 'Team Stats · NW Baseball Stats',
      pageDesc:
        'Team-level hitting and pitching stats for every Northwest college baseball program.',
    },
    '/player-comps': {
      kicker: 'Stats',
      title: 'Player Comps',
      subtitle: "Each player's closest statistical comparables, NW and MLB.",
      pageTitle: 'Player Comps · NW Baseball Stats',
      pageDesc:
        "Each Northwest college player's closest statistical comparables, in-region and MLB.",
    },
    '/top-moments': {
      kicker: 'Win Probability',
      title: 'Top Moments',
      subtitle: "The season's biggest WPA swings and clutch performers.",
      pageTitle: 'Top Moments · NW Baseball Stats',
      pageDesc:
        "The biggest win-probability swings and clutch performances of the Northwest college season.",
    },
    '/pro-tracker': {
      kicker: 'Alumni',
      title: 'Pro Tracker',
      subtitle: 'Northwest college alumni in MiLB and MLB, by school.',
      pageTitle: 'Pro Tracker · NW Baseball Stats',
      pageDesc:
        'Every Northwest college baseball alum currently in affiliated pro ball, grouped by school.',
    },
    '/recruiting': {
      kicker: 'Recruiting',
      title: 'Recruiting Hub',
      subtitle: 'Every recruiting tool for Northwest college baseball, explained.',
      pageTitle: 'Recruiting Hub · NW Baseball Stats',
      pageDesc:
        'Start here: every Northwest college baseball recruiting tool, explained. Free to browse.',
    },
    '/recruiting-classes': {
      kicker: 'Recruiting',
      title: 'Recruiting Classes',
      subtitle: 'Incoming class rankings and breakdowns by program.',
      pageTitle: 'Recruiting Classes · NW Baseball Stats',
      pageDesc:
        'Incoming recruiting class rankings and breakdowns for Northwest college programs.',
    },
    '/summer': {
      kicker: 'Summer Ball',
      title: 'WCL Hub',
      subtitle: "Today's games, leaders, and standings from the West Coast League.",
      pageTitle: 'Summer Ball · NW Baseball Stats',
      pageDesc:
        'West Coast League summer baseball — games, leaders, standings, and player pages.',
    },
    '/pnw-grid': {
      kicker: 'The Game',
      title: 'PNW Grid',
      subtitle: 'Immaculate Grid for Pacific Northwest baseball.',
      pageTitle: 'PNW Grid · NW Baseball Stats',
      pageDesc:
        'Immaculate Grid for Pacific Northwest college baseball. How deep is your roster knowledge?',
    },
    '/team-quiz': {
      kicker: 'The Game',
      title: 'Team Quiz',
      subtitle: 'Test your knowledge of a PNW roster across any season.',
      pageTitle: 'Team Quiz · NW Baseball Stats',
      pageDesc:
        'Test your knowledge of any Northwest college baseball roster across one or more seasons.',
    },
    '/park-factors': {
      kicker: 'Stats',
      title: 'Park Factors',
      subtitle: 'How every Northwest ballpark plays.',
      pageTitle: 'Park Factors · NW Baseball Stats',
      pageDesc:
        'Ballpark run, hit, and home-run effects across Northwest college baseball.',
    },
    '/historic': {
      kicker: 'History',
      title: 'Historic Matchups',
      subtitle: 'Head-to-head history between any two programs.',
      pageTitle: 'Historic Matchups · NW Baseball Stats',
      pageDesc:
        'All-time head-to-head history between any two Northwest college baseball programs.',
    },
    '/graphics-hub': {
      kicker: 'Graphics',
      title: 'Graphics Hub',
      subtitle: 'Daily scores, key matchups, series recaps, and more.',
      pageTitle: 'Graphics Hub · NW Baseball Stats',
      pageDesc:
        'On-demand social media graphics for any Northwest college baseball game or player.',
    },
    '/portal': {
      kicker: 'For Coaches',
      title: 'Coaching & Scouting Portal',
      subtitle:
        'Scouting reports, JUCO tracker, lineup helper, advance reports.',
      pageTitle: 'Coaching Portal · NW Baseball Stats',
      pageDesc:
        'Coach & Scout subscriber portal — scouting reports, JUCO tracker, lineup helper, and more.',
    },
    '/trackman-data': {
      kicker: 'Pitch Lab',
      title: 'TrackMan Data',
      subtitle: 'Pitch shapes, Stuff+ grades, and arsenal rankings.',
      pageTitle: 'TrackMan Data · NW Baseball Stats',
      pageDesc:
        'Pitch-shape data, Stuff+-style pitch grades, and full arsenal rankings for Northwest summer-ball arms.',
    },
    '/coaching/wcl-portal': {
      kicker: 'Transfer Portal',
      title: 'WCL Transfer Portal',
      subtitle: 'West Coast League players on the move, with summer stats.',
      pageTitle: 'WCL Transfer Portal · NW Baseball Stats',
      pageDesc:
        'Every West Coast League player in the transfer portal, with their summer stats and spring school.',
    },
    '/coaching/transfer-portal': {
      kicker: 'Transfer Portal',
      title: 'Transfer Portal Tracker',
      subtitle: 'NCAA transfers into and out of Northwest programs.',
      pageTitle: 'Transfer Portal Tracker · NW Baseball Stats',
      pageDesc:
        'Track NCAA transfers across Northwest college baseball, with stats and destinations.',
    },
    '/coaching/juco-tracker': {
      kicker: 'JUCO',
      title: 'JUCO Tracker',
      subtitle: 'Junior-college players headed to four-year programs.',
      pageTitle: 'JUCO Tracker · NW Baseball Stats',
      pageDesc:
        'Junior-college baseball players and their commitments to four-year Northwest programs.',
    },
    '/wcl-pickem': {
      kicker: 'The Game',
      title: "WCL Pick 'Em",
      subtitle: 'Weekly confidence pool for the West Coast League.',
      pageTitle: "WCL Pick 'Em · NW Baseball Stats",
      pageDesc:
        'Make your weekly West Coast League picks and climb the confidence-pool leaderboard.',
    },
    '/fieldguessr': {
      kicker: 'The Game',
      title: 'FieldGuessr',
      subtitle: 'Guess the Northwest college ballpark from a photo.',
      pageTitle: 'FieldGuessr · NW Baseball Stats',
      pageDesc:
        'A daily guessing game: name the Northwest college baseball ballpark from a single photo.',
    },
    '/pnw-pickle': {
      kicker: 'The Game',
      title: 'PNW Pickle',
      subtitle: 'Guess the Northwest college baseball player.',
      pageTitle: 'PNW Pickle · NW Baseball Stats',
      pageDesc:
        'A daily guess-the-player game for Northwest college baseball. How few clues do you need?',
    },
    '/compare': {
      kicker: 'Stats',
      title: 'Player Compare',
      subtitle: 'Stack any two players side by side.',
      pageTitle: 'Player Compare · NW Baseball Stats',
      pageDesc:
        'Compare any two Northwest college baseball players head-to-head across every stat.',
    },
    '/glossary': {
      kicker: 'Reference',
      title: 'Stat Glossary',
      subtitle: 'Every metric on the site, explained.',
      pageTitle: 'Stat Glossary · NW Baseball Stats',
      pageDesc:
        'Plain-English definitions for every traditional and advanced stat used on NW Baseball Stats.',
    },
    '/all-conference': {
      kicker: 'Awards',
      title: 'All-Conference Teams',
      subtitle: 'Data-driven all-conference selections by league.',
      pageTitle: 'All-Conference · NW Baseball Stats',
      pageDesc:
        'Data-driven all-conference teams across every Northwest college baseball league.',
    },
    '/conference-standings': {
      kicker: 'Conferences',
      title: 'Conference Standings',
      subtitle: 'League-by-league records and seeding.',
      pageTitle: 'Conference Standings · NW Baseball Stats',
      pageDesc: 'Conference-only standings and playoff seeding across every Northwest league.',
    },
    '/opponent-trends': {
      kicker: 'Scouting',
      title: 'Opponent Trends',
      subtitle: 'How teams perform against different styles.',
      pageTitle: 'Opponent Trends · NW Baseball Stats',
      pageDesc: 'Opponent-adjusted performance trends for Northwest college baseball teams.',
    },
    '/tournament-bracket': {
      kicker: 'Postseason',
      title: 'Tournament Bracket',
      subtitle: 'Live conference and national tournament brackets.',
      pageTitle: 'Tournament Bracket · NW Baseball Stats',
      pageDesc: 'Conference and national postseason brackets for Northwest college baseball.',
    },
    '/broadcasts': {
      kicker: 'Watch',
      title: 'Broadcasts',
      subtitle: 'Where to stream Northwest college baseball.',
      pageTitle: 'Broadcasts · NW Baseball Stats',
      pageDesc: 'Streaming and broadcast links for Northwest college baseball games.',
    },
    '/daily-scores': {
      kicker: 'Today',
      title: 'Daily Scores',
      subtitle: "Every Northwest college result, day by day.",
      pageTitle: 'Daily Scores · NW Baseball Stats',
      pageDesc: 'Daily scoreboard for every Northwest college baseball game.',
    },
    '/results': {
      kicker: 'Results',
      title: 'Recent Results',
      subtitle: 'Final scores from around the Northwest.',
      pageTitle: 'Results · NW Baseball Stats',
      pageDesc: 'Recent final scores across Northwest college baseball.',
    },
    '/players': {
      kicker: 'Players',
      title: 'Player Search',
      subtitle: 'Find any Northwest college baseball player.',
      pageTitle: 'Players · NW Baseball Stats',
      pageDesc: 'Search every Northwest college baseball player by name, team, or position.',
    },
    '/summer/standings': {
      kicker: 'Summer Ball',
      title: 'WCL Standings',
      subtitle: 'West Coast League standings and College Power Index.',
      pageTitle: 'WCL Standings · NW Baseball Stats',
      pageDesc: 'West Coast League standings, records, and College Power Index.',
    },
    '/summer/scoreboard': {
      kicker: 'Summer Ball',
      title: 'WCL Scoreboard',
      subtitle: 'Recent and upcoming West Coast League games.',
      pageTitle: 'WCL Scoreboard · NW Baseball Stats',
      pageDesc: 'Scores and schedule for the West Coast League summer season.',
    },
    '/summer/stats': {
      kicker: 'Summer Ball',
      title: 'WCL Leaders',
      subtitle: 'West Coast League hitting and pitching leaders.',
      pageTitle: 'WCL Stats · NW Baseball Stats',
      pageDesc: 'West Coast League statistical leaders for the summer season.',
    },
    '/summer/cpi': {
      kicker: 'Summer Ball',
      title: 'WCL College Power Index',
      subtitle: 'Which colleges send the most WCL talent.',
      pageTitle: 'WCL College Power Index · NW Baseball Stats',
      pageDesc: 'Ranking the colleges that produce the most West Coast League production.',
    },
    '/summer/pnw-alumni': {
      kicker: 'Summer Ball',
      title: 'WCL PNW Alumni',
      subtitle: 'Northwest college players in the West Coast League.',
      pageTitle: 'WCL PNW Alumni · NW Baseball Stats',
      pageDesc: 'Northwest college baseball players competing in the West Coast League.',
    },
    '/recruiting/rankings': {
      kicker: 'Recruiting',
      title: 'Recruiting Rankings',
      subtitle: 'Ranked incoming recruits across the Northwest.',
      pageTitle: 'Recruiting Rankings · NW Baseball Stats',
      pageDesc: 'Ranked incoming recruits headed to Northwest college baseball programs.',
    },
    '/recruiting/map': {
      kicker: 'Recruiting',
      title: 'Recruiting Map',
      subtitle: 'Where Northwest programs pull their talent from.',
      pageTitle: 'Recruiting Map · NW Baseball Stats',
      pageDesc: 'A geographic map of where Northwest college programs recruit their players.',
    },
    '/recruiting/guide': {
      kicker: 'Recruiting',
      title: 'Recruiting Guide',
      subtitle: 'How to get recruited by a Northwest program.',
      pageTitle: 'Recruiting Guide · NW Baseball Stats',
      pageDesc: 'A complete guide to getting recruited by Northwest college baseball programs.',
    },
    '/recruiting/quiz': {
      kicker: 'Recruiting',
      title: 'Find Your Fit',
      subtitle: 'A quiz to match you with Northwest programs.',
      pageTitle: 'Recruiting Quiz · NW Baseball Stats',
      pageDesc: 'Answer a few questions to find the Northwest college programs that fit you best.',
    },
  };

  if (staticRoutes[pathname]) {
    const r = staticRoutes[pathname];
    const ogQs = new URLSearchParams({
      t: 'custom',
      title: r.title,
      subtitle: r.subtitle,
      kicker: r.kicker,
    }).toString();
    return {
      ogParams: ogQs,
      title: r.pageTitle,
      description: r.pageDesc,
    };
  }

  // Default fallback — site card
  return {
    ogParams: 't=default',
    title: 'NW Baseball Stats — Northwest College Baseball Analytics',
    description:
      'Advanced stats for NCAA D1, D2, D3, NAIA, and NWAC programs in WA, OR, ID, MT. WAR, wOBA, FIP, play-by-play, and WPA.',
  };
}

// ────────────────────────────────────────────────────────────────
// Middleware entry
// ────────────────────────────────────────────────────────────────

export default async function middleware(request) {
  const url = new URL(request.url);

  // Only rewrite for HTML page loads (GET, no `Accept: image/*`).
  // Static asset fetches by the SPA itself shouldn't hit here, but
  // the matcher above is broad so we add a defensive check.
  if (request.method !== 'GET') {
    return; // pass through
  }

  const accept = request.headers.get('accept') || '';
  if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
    return;
  }

  // Compute new OG image URL + title + description
  const route = resolveRoute(url.pathname);
  let { title, description } = route;
  const { ogParams, seo } = route;
  const ogImage = `${SITE}/api/og?${ogParams}`;
  const pageUrl = `${SITE}${url.pathname}`;

  // Fetch the SPA shell AND (for player/team pages) the real per-entity SEO
  // metadata in parallel, so crawlers + AI answer engines get an entity-specific
  // <title>, description and schema.org JSON-LD without running our JS.
  let shellResp, seoData = null;
  try {
    const shellP = fetch(`${SITE}/index.html`, { cf: { cacheTtl: 60 } });
    const seoP = seo
      ? fetch(`${API}/seo/meta?type=${seo.type}&id=${seo.id}`, { cf: { cacheTtl: 21600 } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null);
    [shellResp, seoData] = await Promise.all([shellP, seoP]);
  } catch (_) {
    return; // bail to default Vercel routing
  }

  if (!shellResp || !shellResp.ok) {
    return;
  }

  let html = await shellResp.text();

  // Real entity metadata wins over the generic per-route-type defaults.
  let canonical = pageUrl;
  let jsonld = null;
  if (seoData && seoData.ok) {
    if (seoData.title) title = seoData.title;
    if (seoData.description) description = seoData.description;
    if (seoData.canonical) canonical = seoData.canonical;
    jsonld = seoData.jsonld || null;
  }

  // <title> is the strongest on-page SEO signal — set it (not just og:title).
  html = setTitle(html, title);
  // Canonical URL (dedupes querystring/variant URLs for crawlers).
  html = upsertLink(html, 'canonical', canonical);
  // schema.org structured data so search + AI engines resolve the entity.
  if (jsonld) {
    html = injectJsonLd(html, jsonld);
  }

  // Rewrite or insert og:image
  html = upsertMeta(html, {
    property: 'og:image',
    content: ogImage,
  });

  // og:image:width / height are nice-to-have so Twitter knows aspect
  html = upsertMeta(html, { property: 'og:image:width', content: '1200' });
  html = upsertMeta(html, { property: 'og:image:height', content: '630' });

  html = upsertMeta(html, { property: 'og:title', content: title });
  html = upsertMeta(html, {
    property: 'og:description',
    content: description,
  });
  html = upsertMeta(html, { property: 'og:type', content: seo ? 'profile' : 'website' });
  html = upsertMeta(html, { property: 'og:url', content: canonical });

  // Twitter card tags
  html = upsertMeta(html, {
    name: 'twitter:card',
    content: 'summary_large_image',
  });
  html = upsertMeta(html, { name: 'twitter:title', content: title });
  html = upsertMeta(html, { name: 'twitter:description', content: description });
  html = upsertMeta(html, { name: 'twitter:image', content: ogImage });

  // Also update <meta name="description">
  html = upsertMeta(html, { name: 'description', content: description });

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short edge cache; link crawlers will still get fresh data
      // after data changes (~5 min worst case).
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
    },
  });
}

// ────────────────────────────────────────────────────────────────
// String-replace helpers
//
// HTMLRewriter would be cleaner but isn't universally available on
// Vercel's edge runtime. Simple regex replace is fine here because
// index.html is small and the meta tags follow a known shape.
// ────────────────────────────────────────────────────────────────

function escapeAttr(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function upsertMeta(html, { property, name, content }) {
  const key = property || name;
  const attr = property ? 'property' : 'name';
  const safeContent = escapeAttr(content);
  // Build the new tag
  const newTag = `<meta ${attr}="${key}" content="${safeContent}" />`;

  // Try to replace an existing tag. Allow attributes in either
  // order and either quote style.
  const re = new RegExp(
    `<meta\\s+(?:[^>]*\\s)?${attr}=["']${escapeRegex(key)}["'][^>]*>`,
    'i'
  );
  if (re.test(html)) {
    return html.replace(re, newTag);
  }

  // No existing tag — inject just before </head>
  return html.replace(/<\/head>/i, `  ${newTag}\n  </head>`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the document <title>.
function setTitle(html, title) {
  const safe = escapeAttr(title);
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safe}</title>`);
  }
  return html.replace(/<\/head>/i, `  <title>${safe}</title>\n  </head>`);
}

// Upsert a <link rel="..."> (e.g. canonical).
function upsertLink(html, rel, href) {
  const newTag = `<link rel="${rel}" href="${escapeAttr(href)}" />`;
  const re = new RegExp(`<link\\s+(?:[^>]*\\s)?rel=["']${escapeRegex(rel)}["'][^>]*>`, 'i');
  if (re.test(html)) {
    return html.replace(re, newTag);
  }
  return html.replace(/<\/head>/i, `  ${newTag}\n  </head>`);
}

// Inject a schema.org JSON-LD <script> before </head>. The JSON is escaped so a
// stray "</script>" in a value can't break out of the tag.
function injectJsonLd(html, obj) {
  let json;
  try {
    json = JSON.stringify(obj);
  } catch (_) {
    return html;
  }
  const safe = json.replace(/</g, '\\u003c');
  const tag = `<script type="application/ld+json">${safe}</script>`;
  return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
}
