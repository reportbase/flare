// Unit tests for worker.js, run with Node's own test runner (no install, no
// Cloudflare account): the R2 buckets are an in-memory stand-in and outside
// fetches (the Images API, the delivery CDN) are stubbed. They check the
// contract the clients rely on, the bucket fence, CORS, the write gates, all
// three upload modes, paged listing, and the /image routes.
//
//   npm test          (or: node --test)
//
// test.sh is the other half: it runs against the deployed Worker.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

/* ── An in-memory R2 bucket, enough of the API for worker.js ── */
function memoryBucket(pageSize = 1000){
  const store = new Map();
  const record = (key, v) => ({
    key, size: v.bytes.byteLength, uploaded: v.uploaded, httpEtag: `"${key}-etag"`,
    httpMetadata: v.httpMetadata, customMetadata: v.customMetadata,
  });
  return {
    store,
    async put(key, body, opts = {}){
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      store.set(key, { bytes, uploaded: new Date(0), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
    },
    async get(key){
      const v = store.get(key);
      if (!v) return null;
      return {
        ...record(key, v),
        body: new Response(v.bytes).body,
        writeHttpMetadata(h){ if (v.httpMetadata?.contentType) h.set('content-type', v.httpMetadata.contentType); },
      };
    },
    async delete(key){ store.delete(key); },
    async list({ cursor } = {}){
      const keys = [...store.keys()].sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      return { objects: slice.map(k => record(k, store.get(k))), truncated, cursor: truncated ? String(start + pageSize) : undefined };
    },
  };
}

const ORIGIN = 'https://tangent.fit';
let env, realFetch, fetched;

beforeEach(() => {
  env = {
    BUCKET1: memoryBucket(2),              // small pages, so listing has to walk the cursor
    BUCKET2: memoryBucket(),
    SECRET_THING: memoryBucket(),          // bound in env but NOT in the fence
    BUCKETS: 'BUCKET1,BUCKET2',
    ALLOWED_ORIGINS: ORIGIN,
    ALLOWED_WRITE_IPS: '',
    CLOUDFLARE_ACCOUNT_HASH: 'HASH',
    CLOUDFLARE_ID: 'ACCOUNT',
    CLOUDFLARE_IMAGE_TOKEN: 'TOKEN',
  };
  realFetch = globalThis.fetch;
  fetched = [];
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (path, init = {}) => worker.fetch(new Request('https://flare.test' + path, init), env);
const body = r => r.json();

/* ── Fence ── */
test('unknown bucket is 404 and does not list the bindings', async () => {
  const r = await call('/bucket?bucket=NOTABUCKET');
  assert.equal(r.status, 404);
  const text = await r.text();
  assert.doesNotMatch(text, /BUCKET1|availableBuckets/);
});

test('a binding outside BUCKETS cannot be reached', async () => {
  await env.SECRET_THING.put('x', 'hidden');
  assert.equal((await call('/bucket?bucket=SECRET_THING')).status, 404);
  assert.equal((await call('/bucket?bucket=SECRET_THING&key=x')).status, 404);
});

test('bucket name is case-insensitive and defaults to BUCKET1', async () => {
  await env.BUCKET1.put('a.txt', 'A');
  assert.equal((await body(await call('/bucket?bucket=bucket1'))).bucket, 'BUCKET1');
  assert.equal((await body(await call('/bucket'))).bucket, 'BUCKET1');
});

/* ── Reads ── */
test('listing walks every page and keeps the old shape', async () => {
  for (const k of ['a', 'b', 'c', 'd', 'e']) await env.BUCKET1.put(k, k);
  const j = await body(await call('/bucket?bucket=BUCKET1'));
  assert.equal(j.success, true);
  assert.equal(j.truncated, false);
  assert.deepEqual(j.objects.map(o => o.name), ['a', 'b', 'c', 'd', 'e']);
  assert.match(j.objects[0].downloadUrl, /\/bucket\?bucket=BUCKET1&key=a$/);
  assert.match(j.objects[0].metadataUrl, /&meta=true$/);
});

test('get returns the bytes with content type and etag', async () => {
  await env.BUCKET1.put('p.json', '{"x":1}', { httpMetadata: { contentType: 'application/json' } });
  const r = await call('/bucket?bucket=BUCKET1&key=p.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('etag'), '"p.json-etag"');
  assert.equal(await r.text(), '{"x":1}');
});

test('missing object is 404', async () => {
  assert.equal((await call('/bucket?bucket=BUCKET1&key=nope')).status, 404);
});

test('meta=true and meta=1 return metadata JSON', async () => {
  await env.BUCKET1.put('m', 'hello', { customMetadata: { who: 'me' } });
  for (const m of ['true', '1']){
    const j = await body(await call(`/bucket?bucket=BUCKET1&key=m&meta=${m}`));
    assert.equal(j.success, true);
    assert.equal(j.size, 5);
    assert.deepEqual(j.customMetadata, { who: 'me' });
    assert.equal(j.contentType, 'application/octet-stream');
  }
});

/* ── CORS ── */
test('reads are public, an allowed origin is echoed back', async () => {
  assert.equal((await call('/bucket?bucket=BUCKET1')).headers.get('access-control-allow-origin'), '*');
  const r = await call('/bucket?bucket=BUCKET1', { headers: { Origin: ORIGIN } });
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(r.headers.get('vary'), 'Origin');
  const other = await call('/bucket?bucket=BUCKET1', { headers: { Origin: 'https://reportbase.github.io' } });
  assert.equal(other.headers.get('access-control-allow-origin'), '*');
});

test('preflight is 204', async () => {
  const r = await call('/bucket', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
});

/* ── Write gates ── */
test('a foreign origin cannot write or delete', async () => {
  await env.BUCKET1.put('keep', 'x');
  const post = await call('/bucket?bucket=BUCKET1&key=k', { method: 'POST', body: 'x', headers: { Origin: 'https://evil.example' } });
  assert.equal(post.status, 403);
  const del = await call('/bucket?bucket=BUCKET1&key=keep', { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
  assert.equal(del.status, 403);
  assert.ok(env.BUCKET1.store.has('keep'));
});

test('the IP fence, when set, refuses other addresses', async () => {
  env.ALLOWED_WRITE_IPS = '1.2.3.4';
  const no = await call('/bucket?bucket=BUCKET1&key=k', { method: 'POST', body: 'x', headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  assert.equal(no.status, 403);
  const yes = await call('/bucket?bucket=BUCKET1&key=k', { method: 'POST', body: 'x', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(yes.status, 200);
});

/* ── Upload modes ── */
test('multipart upload: file plus metadata parts', async () => {
  const form = new FormData();
  form.append('file', new Blob(['pixels'], { type: 'image/png' }), 'a.png');
  form.append('title', 'A');
  form.append('metadata', JSON.stringify({ w: '10' }));
  const j = await body(await call('/bucket?bucket=BUCKET1&key=a.png', { method: 'POST', body: form, headers: { Origin: ORIGIN } }));
  assert.equal(j.success, true);
  assert.deepEqual(j.metadata, { title: 'A', w: '10' });
  const v = env.BUCKET1.store.get('a.png');
  assert.equal(new TextDecoder().decode(v.bytes), 'pixels');
  assert.equal(v.httpMetadata.contentType, 'image/png');
});

test('multipart without a file is 400', async () => {
  const form = new FormData(); form.append('title', 'A');
  assert.equal((await call('/bucket?bucket=BUCKET1&key=k', { method: 'POST', body: form })).status, 400);
});

test('JSON upload, plain and base64', async () => {
  const post = obj => call('/bucket?bucket=BUCKET1&key=j', { method: 'POST', body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await post({ content: 'plain', contentType: 'text/plain' })).status, 200);
  assert.equal(new TextDecoder().decode(env.BUCKET1.store.get('j').bytes), 'plain');
  assert.equal((await post({ content: Buffer.from('bin').toString('base64'), encoding: 'base64' })).status, 200);
  assert.equal(new TextDecoder().decode(env.BUCKET1.store.get('j').bytes), 'bin');
});

test('JSON with no content updates metadata and keeps the body', async () => {
  await env.BUCKET1.put('j', 'body', { httpMetadata: { contentType: 'text/plain' } });
  const r = await call('/bucket?bucket=BUCKET1&key=j', { method: 'POST', body: JSON.stringify({ metadata: { tag: 'x' } }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  const v = env.BUCKET1.store.get('j');
  assert.equal(new TextDecoder().decode(v.bytes), 'body');
  assert.deepEqual(v.customMetadata, { tag: 'x' });
  assert.equal(v.httpMetadata.contentType, 'text/plain');
  const missing = await call('/bucket?bucket=BUCKET1&key=none', { method: 'POST', body: JSON.stringify({ metadata: { a: 1 } }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(missing.status, 404);
});

test('raw upload with X-Custom-Metadata', async () => {
  const r = await call('/bucket?bucket=BUCKET1&key=r', { method: 'POST', body: 'raw!', headers: { 'X-Custom-Metadata': '{"a":"b"}' } });
  assert.deepEqual((await body(r)).metadata, { a: 'b' });
  assert.equal(new TextDecoder().decode(env.BUCKET1.store.get('r').bytes), 'raw!');
});

test('POST and DELETE need a key; delete removes the object', async () => {
  assert.equal((await call('/bucket?bucket=BUCKET1', { method: 'POST', body: 'x' })).status, 400);
  assert.equal((await call('/bucket?bucket=BUCKET1', { method: 'DELETE' })).status, 400);
  await env.BUCKET1.put('gone', 'x');
  assert.equal((await call('/bucket?bucket=BUCKET1&key=gone', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/bucket?bucket=BUCKET1&key=gone')).status, 404);
});

test('other methods on /bucket are 405', async () => {
  assert.equal((await call('/bucket?bucket=BUCKET1&key=k', { method: 'PUT', body: 'x' })).status, 405);
});

/* ── Images ── */
function stubFetch(responder){
  globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), init }); return responder(String(url), init); };
}

test('variant goes through the delivery CDN', async () => {
  stubFetch(() => new Response('jpg', { headers: { 'content-type': 'image/jpeg' } }));
  const r = await call('/image?image_id=IMG&v=1024x1024');
  assert.equal(r.status, 200);
  assert.equal(fetched[0].url, 'https://imagedelivery.net/HASH/IMG/1024x1024');
  assert.equal(r.headers.get('x-image-id'), 'IMG');
  assert.equal(await r.text(), 'jpg');
});

test('a missing variant is 404', async () => {
  stubFetch(() => new Response('no', { status: 404 }));
  assert.equal((await call('/image?image_id=IMG&v=x')).status, 404);
});

test('blob and meta go through the Images API with the token', async () => {
  stubFetch(url => url.endsWith('/blob')
    ? new Response('orig', { headers: { 'content-type': 'image/png' } })
    : Response.json({ success: true, result: { meta: { title: 't' } } }));
  const b = await call('/image?blob=IMG');
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('content-disposition'), 'attachment; filename="IMG.png"');
  assert.equal(fetched[0].url, 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT/images/v1/IMG/blob');
  assert.equal(fetched[0].init.headers.Authorization, 'Bearer TOKEN');
  assert.deepEqual(await body(await call('/image?meta=IMG')), { success: true, meta: { title: 't' } });
});

test('/image refuses writes and needs parameters', async () => {
  assert.equal((await call('/image?image_id=x', { method: 'DELETE' })).status, 405);
  assert.equal((await call('/image')).status, 400);
});

/* ── Router ── */
test('unknown route is 404, a thrown error is a 500 with CORS', async () => {
  assert.equal((await call('/nothing')).status, 404);
  env.BUCKET1.list = async () => { throw new Error('r2 down'); };
  const r = await call('/bucket?bucket=BUCKET1');
  assert.equal(r.status, 500);
  assert.equal((await body(r)).error, 'r2 down');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});
