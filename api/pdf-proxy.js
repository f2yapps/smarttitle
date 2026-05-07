// Server-side PDF proxy — fetches any HTTPS PDF and returns bytes to the browser.
// Bypasses CORS and Cloudflare restrictions that block browser-based proxy services.
export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  // Only allow HTTPS to avoid SSRF against internal/local resources
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'Only HTTPS URLs allowed' });
  // Block private/loopback ranges
  const host = parsed.hostname.toLowerCase();
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return res.status(400).json({ error: 'Private URLs not allowed' });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': parsed.origin + '/',
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream returned HTTP ${upstream.status}` });
    }

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > 30 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (>30 MB)' });
    }

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    return res.status(502).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
