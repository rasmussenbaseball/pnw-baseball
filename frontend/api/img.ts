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

// Identify an image format from its leading magic bytes. Content-type headers
// on these third-party / CDN responses are unreliable (often empty), so the
// bytes are the source of truth — and knowing the real format lets us reject
// WebP (which Satori can't render) in favor of the JPG/PNG original.
function sniffImageType(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  // RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
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
    let upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'NWBaseballStats-ImageProxy/1.0 (+https://nwbaseballstats.com)',
        Accept: 'image/png,image/jpeg,image/*;q=0.8',
      },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return new Response('upstream error', { status: 502 });
    }

    // Buffer + sniff. Content-type headers are unreliable here (the CloudFront
    // originals often come back with NO content-type at all), so we identify
    // the real format from the magic bytes.
    let buf = await upstream.arrayBuffer();
    let ct = sniffImageType(buf) ||
      (upstream.headers.get('content-type') || '').toLowerCase().split(';')[0];

    // Sidearm sites 302 their /images/ paths through
    // images.sidearmdev.com/resize?...&type=webp, which returns WebP — and
    // Satori (the OG renderer) can't embed WebP, so those headshots came back
    // blank. When we land on that converter and don't already have a Satori-
    // friendly format, step around it and fetch the ORIGINAL (JPG/PNG) source
    // from the converter's `url` param. Sniff the alt too, because CloudFront
    // returns it with an empty content-type (that empty header is exactly why
    // the old header-only check rejected it and fell back to webp).
    if (upstream.url.includes('images.sidearmdev.com/') &&
        ct !== 'image/jpeg' && ct !== 'image/png' && ct !== 'image/gif') {
      try {
        const inner = new URL(upstream.url);
        const direct = inner.searchParams.get('url');
        if (direct) {
          const controller2 = new AbortController();
          const t2 = setTimeout(() => controller2.abort(), 8000);
          const alt = await fetch(direct, {
            signal: controller2.signal,
            redirect: 'follow',
            headers: {
              'User-Agent':
                'NWBaseballStats-ImageProxy/1.0 (+https://nwbaseballstats.com)',
              Accept: 'image/png,image/jpeg,image/*;q=0.8',
            },
          });
          clearTimeout(t2);
          if (alt.ok) {
            const altBuf = await alt.arrayBuffer();
            const altCt = sniffImageType(altBuf);
            if (altCt === 'image/jpeg' || altCt === 'image/png' || altCt === 'image/gif') {
              buf = altBuf;
              ct = altCt;
            }
          }
        }
      } catch (_) {
        // Fall through to the original (webp) response — better than
        // failing entirely.
      }
    }

    if (!ct || !ct.startsWith('image/')) {
      return new Response('not an image', { status: 415 });
    }

    const headers = new Headers();
    headers.set('Content-Type', ct);
    headers.set('Content-Length', String(buf.byteLength));
    headers.set(
      'Cache-Control',
      'public, immutable, no-transform, max-age=86400, s-maxage=86400'
    );
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(buf, {
      status: 200,
      headers,
    });
  } catch (_e) {
    return new Response('proxy failed', { status: 500 });
  }
}
