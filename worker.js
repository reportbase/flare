/* api.tangent.workers.dev — bucket + image access, clean rebuild.
 *
 * A faithful port of the two routes the clients actually call, out of the
 * old component's fifteen. The contract is preserved verbatim from the old
 * /bucket and /image GET handlers; everything else — views, users, tokens,
 * publishing (POST/DELETE /image), bucket-html, styles, AI — deliberately
 * lives elsewhere. A route that exists must keep working, so the cheapest
 * maintenance is not to have it.
 *
 *   GET    /bucket?bucket=NAME              -> { success, bucket, objects:[...] }
 *   GET    /bucket?bucket=NAME&key=K        -> the object's bytes
 *   GET    /bucket?bucket=NAME&key=K&meta=true|1 -> object metadata JSON
 *   POST   /bucket?bucket=NAME&key=K        -> upload (multipart | JSON | raw body)
 *   DELETE /bucket?bucket=NAME&key=K        -> { success }
 *
 *   GET    /image?image_id=ID&v=VARIANT     -> variant bytes via imagedelivery.net
 *   GET    /image?blob=ID                   -> original bytes via the Images API
 *   GET    /image?meta=ID                   -> image metadata via the Images API
 *
 * Departures from the old component, all deliberate:
 *   - ?bucket= passes through the BUCKETS fence, not raw env indexing —
 *     env also holds secrets, and the old 404 listed the bindings to anyone.
 *   - Listing walks the cursor: a bucket past 1000 objects no longer
 *     silently truncates. `truncated: false` kept for shape compatibility.
 *   - Writes (POST/DELETE) are origin-gated server-side by ALLOWED_ORIGINS.
 *     The old component had no write protection at all.
 *   - /image drops the D1 decorations (X-User-ID header, user join on meta)
 *     and analytics logging — publish-world concerns. No DATABASE binding.
 *   - CORS policy is decided in one function, not spread across handlers.
 *
 * Config (wrangler.toml + secrets):
 *   R2 bindings BUCKET1/BUCKET2/REPORTBASE; BUCKETS fence; ALLOWED_ORIGINS.
 *   CLOUDFLARE_ACCOUNT_HASH, CLOUDFLARE_ID (vars — in wrangler.toml).
 *   CLOUDFLARE_IMAGE_TOKEN (the one secret — the Images API bearer).
 */

/* ── CORS: one policy, one place ──────────────────────────────────────── */
const corsHeaders = (env, origin) => {
  const writers = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const writeOk = origin && writers.includes(origin);
  return {
    'Access-Control-Allow-Origin': writeOk ? origin : '*',
    ...(writeOk ? { 'Vary': 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Custom-Metadata',
    'Access-Control-Max-Age': '86400',
  };
};

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const fail = (message, status, cors) => json({ success: false, error: message }, status, cors);

/* ── Buckets ──────────────────────────────────────────────────────────── */
const bucketOf = (env, name) => {
  const allowed = (env.BUCKETS || 'BUCKET1').split(',').map(s => s.trim());
  return allowed.includes(name) ? env[name] : null;
};

const objectURLs = (origin, bucket, key) => ({
  downloadUrl: `${origin}/bucket?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`,
  metadataUrl: `${origin}/bucket?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}&meta=true`,
});

async function handleBucket(request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const name = (url.searchParams.get('bucket') || 'BUCKET1').toUpperCase();
  const bucket = bucketOf(env, name);
  if (!bucket) return fail(`Bucket '${name}' not found`, 404, cors);

  if (request.method === 'GET' && !key) {
    /* List. R2 pages at 1000; walk the cursor so the client always sees
     * the whole bucket. truncated/cursor kept in the shape, now honest. */
    const objects = [];
    let cursor;
    do {
      const page = await bucket.list({ cursor });
      for (const o of page.objects) {
        objects.push({
          name: o.key, size: o.size, uploadedAt: o.uploaded,
          httpEtag: o.httpEtag, customMetadata: o.customMetadata,
          ...objectURLs(url.origin, name, o.key),
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ success: true, bucket: name, objects, truncated: false, cursor: undefined }, 200, cors);
  }

  if (request.method === 'GET') {
    const object = await bucket.get(key);
    if (!object) return fail(`Object '${key}' not found in bucket '${name}'`, 404, cors);

    const meta = url.searchParams.get('meta');
    if (meta === 'true' || meta === '1') {
      return json({
        success: true, bucket: name, key,
        size: object.size, uploaded: object.uploaded,
        httpEtag: object.httpEtag, httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata || {},
        contentType: object.httpMetadata?.contentType || 'application/octet-stream',
        downloadUrl: objectURLs(url.origin, name, key).downloadUrl,
      }, 200, cors);
    }

    const responseHeaders = new Headers(cors);
    object.writeHttpMetadata(responseHeaders);
    responseHeaders.set('etag', object.httpEtag);
    return new Response(object.body, { headers: responseHeaders });
  }

  if (request.method === 'POST') {
    if (!key) return fail('Missing required parameter: key', 400, cors);
    const contentType = request.headers.get('Content-Type') || '';

    /* Three upload modes, same as always:
     * multipart — a 'file' part; every other part becomes customMetadata,
     *   and a part named 'metadata' is parsed as a JSON block of it.
     * JSON — { content, contentType, encoding: 'base64'?, metadata }; with
     *   no content it re-puts the existing body to update metadata alone.
     * raw — the body as-is, metadata via the X-Custom-Metadata header. */
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return fail('No file provided in form data', 400, cors);
      const customMetadata = {};
      for (const [n, v] of form.entries()) {
        if (n === 'file') continue;
        if (n === 'metadata') {
          try { Object.assign(customMetadata, JSON.parse(v)); }
          catch { customMetadata[n] = v; }
        } else customMetadata[n] = v;
      }
      await bucket.put(key, file, {
        httpMetadata: file.type ? { contentType: file.type } : undefined,
        customMetadata: Object.keys(customMetadata).length ? customMetadata : undefined,
      });
      return json({
        success: true, bucket: name, key, metadata: customMetadata,
        ...objectURLs(url.origin, name, key),
      }, 200, cors);
    }

    if (contentType.includes('application/json')) {
      const { metadata, content, contentType: fileType, encoding } = await request.json();
      let body, options = {};
      if (content != null) {
        if (encoding === 'base64') {
          const bin = atob(content);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          body = bytes.buffer;
        } else body = content;
        if (fileType) options.httpMetadata = { contentType: fileType };
      } else {
        const existing = await bucket.get(key);
        if (!existing) return fail(`Object '${key}' not found. Cannot update metadata without content.`, 404, cors);
        body = existing.body;
        if (existing.httpMetadata) options.httpMetadata = existing.httpMetadata;
      }
      if (metadata && Object.keys(metadata).length) options.customMetadata = metadata;
      await bucket.put(key, body, options);
      return json({
        success: true, bucket: name, key, metadata: metadata || {},
        ...objectURLs(url.origin, name, key),
      }, 200, cors);
    }

    let customMetadata;
    const metaHeader = request.headers.get('X-Custom-Metadata');
    if (metaHeader) { try { customMetadata = JSON.parse(metaHeader); } catch {} }
    await bucket.put(key, request.body, { customMetadata });
    return json({
      success: true, bucket: name, key, metadata: customMetadata || {},
      ...objectURLs(url.origin, name, key),
    }, 200, cors);
  }

  if (request.method === 'DELETE') {
    if (!key) return fail('Missing required parameter: key', 400, cors);
    await bucket.delete(key);
    return json({ success: true, bucket: name, key }, 200, cors);
  }

  return fail(`${request.method} not supported on /bucket`, 405, cors);
}

/* ── Images ───────────────────────────────────────────────────────────────
 * Three GET modes, exactly the old semantics minus the D1 decorations:
 * variants ride the public delivery CDN with the variant name passed
 * through untouched (the account's variants include the WxH-named set);
 * blob and meta ride the authenticated Images API. */
const imagesAPI = (env, path) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ID}/images/v1/${path}`, {
    headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_IMAGE_TOKEN}` },
  });

async function handleImage(request, env, cors) {
  if (request.method !== 'GET')
    return fail(`${request.method} not supported on /image — publishing lives on the publish component`, 405, cors);
  const url = new URL(request.url);
  const image_id = url.searchParams.get('image_id');
  const variant = url.searchParams.get('v');
  const blob = url.searchParams.get('blob');
  const meta = url.searchParams.get('meta');

  if (meta) {
    const r = await imagesAPI(env, meta);
    if (!r.ok) return fail(`Failed to get image metadata: ${r.status} ${await r.text()}`, r.status, cors);
    const doc = await r.json();
    if (!doc.success) return fail(doc.errors?.[0]?.message || 'Unknown error', 400, cors);
    return json({ success: true, meta: doc.result.meta || {} }, 200, cors);
  }

  if (blob) {
    const r = await imagesAPI(env, `${blob}/blob`);
    if (!r.ok) return fail(`Failed to get image blob: ${r.status} ${await r.text()}`, r.status, cors);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const extension = contentType.includes('/') ? contentType.split('/')[1] : 'jpg';
    return new Response(r.body, {
      headers: {
        ...cors,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${blob}.${extension}"`,
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  }

  if (variant && image_id) {
    const r = await fetch(
      `https://imagedelivery.net/${env.CLOUDFLARE_ACCOUNT_HASH}/${image_id}/${variant}`,
      { cf: { cacheEverything: true, cacheTtl: 86400 } },
    );
    if (!r.ok) {
      if (r.status === 404) return fail('Image not found', 404, cors);
      return fail(`Error fetching image: ${r.status} ${await r.text()}`, r.status, cors);
    }
    return new Response(r.body, {
      headers: {
        ...cors,
        'Content-Type': r.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000',
        'X-Image-Id': image_id,
        'X-Image-Variant': variant,
      },
    });
  }

  return fail('Missing required parameters. Use one of: image_id+v, meta, or blob', 400, cors);
}

/* ── Router ───────────────────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    /* Writes are gated server-side, which the old component never did.
     * Two independent fences, each active only when its var is non-empty:
     *   ALLOWED_ORIGINS    — browser pages must be on the list (no-Origin
     *                        callers like curl pass this one).
     *   ALLOWED_WRITE_IPS  — the caller's IP must be on the list, browser
     *                        or not. CF-Connecting-IP is set by Cloudflare
     *                        itself, so it cannot be spoofed by the client.
     * Reads stay public: they serve anonymous image tags. */
    if (request.method === 'POST' || request.method === 'DELETE') {
      const origin = request.headers.get('Origin');
      const writers = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (origin && !writers.includes(origin)) return fail('origin not allowed to write', 403, cors);
      const ips = (env.ALLOWED_WRITE_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (ips.length) {
        const ip = request.headers.get('CF-Connecting-IP') || '';
        if (!ips.includes(ip)) return fail('address not allowed to write', 403, cors);
      }
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/bucket') return await handleBucket(request, env, cors);
      if (url.pathname === '/image')  return await handleImage(request, env, cors);
      return fail(`no route ${url.pathname} — this component serves /bucket and /image`, 404, cors);
    } catch (e) {
      console.error(`[api] ${request.method} ${url.pathname}:`, e);
      return fail(e.message || 'internal error', 500, cors);
    }
  },
};
