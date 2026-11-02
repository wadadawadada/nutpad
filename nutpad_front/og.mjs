// Server-side Open Graph / Twitter Card tags for link previews.
// Social apps and Nostr clients fetch the URL WITHOUT running JavaScript, so a client-rendered SPA
// would show an empty preview. This injects the tags into index.html for /token/:id (and defaults elsewhere).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const SITE = {
  title: 'nutpad — Cashu token launchpad',
  description: 'Launch ecash memes. Trade on a curve. Cashu ecash tokens with Nostr login, a local-first wallet and a public, verifiable audit log.',
};

function tagsFor({ title, description, url, image, big, wide }) {
  const t = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'nutpad'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['name', 'description', description],
    ['name', 'twitter:card', image && big ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
  ];
  if (image) {
    t.push(['property', 'og:image', image], ['property', 'og:image:alt', title], ['name', 'twitter:image', image], ['name', 'twitter:image:alt', title]);
    if (wide) t.push(['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630'], ['property', 'og:image:type', 'image/png']);
  }
  return t.map(([k, n, v]) => `<meta ${k}="${esc(n)}" content="${esc(v)}" />`).join('\n    ');
}

async function fetchAsset(apiUrl, id) {
  try {
    const res = await fetch(`${apiUrl}/assets/${id}`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** @param html the built index.html  @param opts { origin, apiUrl, path } */
export async function withPreview(html, { origin, apiUrl, path }) {
  let meta = { title: SITE.title, description: SITE.description, url: origin + path, image: `${origin}/og-image.png`, big: true, wide: true };
  const m = /^\/token\/([0-9a-f]{64})\/?$/.exec(path);
  if (m) {
    const a = await fetchAsset(apiUrl, m[1]);
    if (a) {
      const pct = (Number(BigInt(a.supply) * 10000n / 21000000n) / 100).toFixed(2);
      meta = {
        title: `${a.name} ($${a.ticker}) — nutpad`,
        description: `${a.description ? a.description.slice(0, 160) + ' · ' : ''}Supply ${nf(a.supply)} / 21,000,000 (${pct}%) · ${nf(a.volume_sats)} sats volume · ${nf(a.trade_count)} trades`,
        url: origin + path,
        image: `${apiUrl}/assets/${a.asset_id}/image`, // must be publicly reachable: deploy the API on a public URL
        big: false,
      };
    }
  }
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace('</head>', `    ${tagsFor(meta)}\n  </head>`);
}
