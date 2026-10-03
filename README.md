# flare

The Cloudflare Worker behind **https://flare.tangent.workers.dev**. It reads
and writes files in the R2 storage buckets and serves images from Cloudflare
Images. games, draw and the other pages use it to list and load files (chess
piece shapes, pictures, game records).

It is a server, not a web page, so it is deployed with Wrangler rather than
GitHub Pages.

## Routes

| Request | Returns |
| --- | --- |
| `GET /bucket?bucket=NAME` | Every object in the bucket: `{ success, bucket, objects: [...] }` |
| `GET /bucket?bucket=NAME&key=K` | The object's bytes |
| `GET /bucket?bucket=NAME&key=K&meta=true` | The object's metadata as JSON |
| `POST /bucket?bucket=NAME&key=K` | Uploads (multipart form, JSON, or a raw body) |
| `DELETE /bucket?bucket=NAME&key=K` | Deletes the object |
| `GET /image?image_id=ID&v=VARIANT` | An image variant, via imagedelivery.net |
| `GET /image?blob=ID` | The original image, via the Images API |
| `GET /image?meta=ID` | Image metadata, via the Images API |

Bucket names are `BUCKET1`, `BUCKET2` and `REPORTBASE`. Only names listed in
`BUCKETS` in `wrangler.toml` are reachable.

**Reads** are open to any site. **Writes** (POST and DELETE) from a browser are
allowed only from the sites in `ALLOWED_ORIGINS` (currently `https://tangent.fit`),
and only from the addresses in `ALLOWED_WRITE_IPS` when that is set.

## Files

| File | What it is |
| --- | --- |
| `worker.js` | The whole Worker. |
| `wrangler.toml` | Cloudflare settings: the bucket bindings, `BUCKETS`, `ALLOWED_ORIGINS`, `ALLOWED_WRITE_IPS`, account ids. |
| `tests/worker.test.mjs` | Unit tests (see below). |
| `test.sh` | Live checks against the deployed Worker (or `wrangler dev`). |

## Tests

**Unit tests** run on every pull request in GitHub Actions, and need nothing
installed beyond Node 22:

```sh
npm test
```

They load `worker.js` directly, with in-memory buckets and stubbed calls to
Cloudflare, and check the bucket fence, CORS, the write gates, all three upload
modes, paged listing, and the image routes.

**Live checks** hit the real Worker, including a real upload and delete in
`BUCKET1`:

```sh
./test.sh                                  # the deployed Worker
BASE=http://localhost:8787 ./test.sh       # a local wrangler dev
IMAGE_ID=... ./test.sh                     # also the /image routes
```

## Running and deploying

```sh
npm install
npx wrangler dev        # local server on http://localhost:8787
npx wrangler deploy     # publish to flare.tangent.workers.dev
```

Deploying needs a Cloudflare login (`npx wrangler login`). The Worker needs one
secret, set once:

```sh
npx wrangler secret put CLOUDFLARE_IMAGE_TOKEN    # Cloudflare Images API token
```

Merging to `main` does **not** deploy by itself. Run `npx wrangler deploy`
after merging.
