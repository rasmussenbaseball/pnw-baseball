// Image proxy at /api/img?url=<encoded_url>.
//
// Wraps third-party image URLs in a same-origin endpoint so that
// Satori (under @vercel/og) gets a clean, redirect-free response.
// Many of our headshots live on Sidearm-style URLs that 302 to a
// CDN converter; Satori can't follow those itself, so we resolve
// them here and stream the final image back.
//
// Cached aggressively at the edge (1 day) since headshots / logos
// change rarely.

export const config = { runtime: 'edge' };

const ALLOWED_HOSTS = new Set([
  // Our own assets
  'nwbaseballstats.com',
  'www.nwbaseballstats.com',
  'api.nwbaseballstats.com',
  // Supabase storage where we host article cover images
  'bsyqemdjdkhotmaduldv.supabase.co',
  // Sidearm-style college athletics hosts (D1/D2/D3/NAIA)
  'sidearmdev.com',
  'images.sidearmdev.com',
  'sidearmsports.com',
  // Cloudflare/AWS CDNs we frequently see in redirect targets
  'cloudfront.net',
  // Common school athletics domains we encounter — leave broad,
  // we validate by content-type below as the real safety check.
]);

function isAllowedHost(host: string) {
  if (!host) return false;
  if (ALLOWED_HOSTS.has(host)) return true;
  // Allow any *.cloudfront.net or *.amazonaws.com
  if (host.endsWith('.cloudfront.net')) return true;
  if (host.endsWith('.amazonaws.com')) return true;
  if (host.endsWith('.sidearmsports.com')) return true;
  if (host.endsWith('.sidearmdev.com')) return true;
  // College athletics domains follow patterns like *.edu, *cougars.com,
  // *broncos.com, etc. — open up domains commonly used for athletics
  // pages. If something abusive sneaks in we still validate the
  // response is actually an image below.
  if (
    /\.(edu|com|ca|net|org)$/.test(host) &&
    /^[a-z0-9\-.]+$/i.test(host)
  ) {
    return true;
  }
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('missing url', { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('invalid url', { status: 400 });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return new Response('unsupported protocol', { status: 400 });
  }

  if (!isAllowedHost(parsed.hostname)) {
    return new Response('host not allowed', { status: 403 });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'NWBaseballStats-ImageProxy/1.0 (+https://nwbaseballstats.com)',
        Accept: 'image/*',
      },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return new Response('upstream error', { status: 502 });
    }

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) {
      return new Response('not an image', { status: 415 });
    }

    // Stream the bytes through. Strip any cookies / privileged
    // upstream headers, set our own caching.
    const headers = new Headers();
    headers.set('Content-Type', ct);
    headers.set(
      'Cache-Control',
      'public, immutable, no-transform, max-age=86400, s-maxage=86400'
    );
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: 200,
      headers,
    });
  } catch (_e) {
    return new Response('proxy failed', { status: 500 });
  }
}
