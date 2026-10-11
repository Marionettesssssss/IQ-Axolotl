const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function buildLoveCard(siteUrl, now = new Date()) {
  const time = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
  }).format(now);
  return {
    type: 'flex',
    altText: `💗 มีคนกด “ตกลง” ในจดหมายของเธอแล้ว! ${time} น.`,
    contents: {
      type: 'bubble', size: 'mega',
      hero: {
        type: 'image', url: new URL('/axolotl.png', siteUrl).href,
        size: 'full', aspectRatio: '1:1', aspectMode: 'cover',
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md',
        backgroundColor: '#FFFCF5',
        contents: [
          { type: 'text', text: 'A LITTLE LOVE UPDATE', size: 'xxs', color: '#B96C8B' },
          { type: 'text', text: 'เขากด “ตกลง” แล้ว! 💗', size: 'lg', weight: 'bold', color: '#514D59', wrap: true },
          { type: 'text', text: 'เจ้าสองตัวมีข่าวดีมาบอก\nมีคนตอบรับความในใจของเธอแล้วนะ', size: 'sm', color: '#887684', wrap: true },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#FFF0F6',
            cornerRadius: '10px', paddingAll: '12px',
            contents: [{ type: 'text', text: '♥ ตอบรับเป็นคนพิเศษ', size: 'sm', color: '#B96C8B', wrap: true }],
          },
          { type: 'text', text: `${date} · ${time} น. (เวลาไทย)`, size: 'xs', color: '#887684', wrap: true },
          { type: 'separator', color: '#F0DDE5' },
          { type: 'text', text: 'เริ่มเรื่องราวของเราสองคนแล้วนะ ♥', size: 'xs', color: '#B96C8B', wrap: true },
        ],
      },
    },
  };
}

// The token and recipient are read exclusively from Cloudflare runtime secrets.
export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const url = new URL(request.url);
  const siteUrl = new URL(env.SITE_URL || 'https://our-axolotl.pages.dev');
  // Do not send notifications from Cloudflare preview deployments.
  if (url.origin !== siteUrl.origin || request.headers.get('Origin') !== siteUrl.origin) {
    return json({ error: 'origin_not_allowed' }, 403);
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return json({ error: 'json_required' }, 415);
  }
  if (Number(request.headers.get('Content-Length')) > 1024) return json({ error: 'too_large' }, 413);
  let input;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return json({ error: 'too_large' }, 413);
    input = JSON.parse(raw);
  } catch { return json({ error: 'invalid_json' }, 400); }
  if (!input || input.event !== 'accepted' || !UUID.test(input.eventId || '')) {
    return json({ error: 'invalid_event' }, 400);
  }
  const acceptedAt = new Date(input.acceptedAt);
  const age = Date.now() - acceptedAt.getTime();
  // Keep the same message timestamp on retries, within LINE's 24-hour window.
  if (!Number.isFinite(age) || age < -300000 || age > 23 * 60 * 60 * 1000) {
    return json({ error: 'invalid_event_time' }, 400);
  }
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !/^U[0-9a-f]{32}$/i.test(env.LINE_USER_ID || '')) {
    return json({ error: 'line_not_configured' }, 503);
  }

  // Best-effort per-location cooldown; no database or IP addresses are stored.
  const cache = globalThis.caches?.default;
  let cooldownKey;
  if (cache) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    cooldownKey = new Request(`${siteUrl.origin}/__line_cooldown/${hash}`);
    const previous = await cache.match(cooldownKey);
    if (previous) {
      if ((await previous.text()) === input.eventId) return json({ ok: true, duplicate: true });
      return json({ error: 'please_wait' }, 429, { 'Retry-After': '60' });
    }
  }
  try {
    const result = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        // LINE deduplicates retries of the same event across server locations.
        'X-Line-Retry-Key': input.eventId,
      },
      body: JSON.stringify({ to: env.LINE_USER_ID, messages: [buildLoveCard(siteUrl.href, acceptedAt)] }),
    });
    // A 409 with this header means LINE already accepted the same retry key.
    const duplicate = result.status === 409 && result.headers.has('x-line-accepted-request-id');
    if (!result.ok && !duplicate) {
      console.error('LINE notification failed; HTTP status:', result.status);
      return json({ error: 'line_send_failed' }, 502);
    }
    if (cache && cooldownKey) {
      try { await cache.put(cooldownKey, new Response(input.eventId, { headers: { 'Cache-Control': 'public, max-age=60' } })); }
      catch { /* A cache failure must not undo a successful LINE request. */ }
    }
    return json({ ok: true });
  } catch {
    console.error('LINE notification network error');
    return json({ error: 'line_send_failed' }, 502);
  }
}
