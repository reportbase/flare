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

**Reads** are open to any site. **Writes** (POST and DELETE) need permission,
in one of two ways:

- **The write token:** send `Authorization: Bearer <WRITE_TOKEN>`. This is how
  scripts and tools upload.
- **An allowed site:** a browser page on `ALLOWED_ORIGINS` (currently
  `https://tangent.fit`) may still write without the token, while
  `ALLOW_ORIGIN_WRITES` is `"true"`. This keeps existing uploaders working while
  they move to the token. Set it to `"false"` once they send it: a browser can't
  fake which site it's on, but other clients can claim one.

Everything else is refused. When `ALLOWED_WRITE_IPS` is set, the caller's
address must also be on it.

## Files

| File | What it is |
| --- | --- |
| `worker.js` | The whole Worker. |
| `wrangler.toml` | Cloudflare settings: the bucket bindings, `BUCKETS`, `ALLOWED_ORIGINS`, `ALLOW_ORIGIN_WRITES`, `ALLOWED_WRITE_IPS`, account ids. |
| `tests/worker.test.mjs` | Unit tests (see below). |
| `test.sh` | Live checks against the deployed Worker (or `wrangler dev`). |

## Tests

**Unit tests** run on every pull request in GitHub Actions, and need nothing
installed beyond Node 22:

```sh
npm test
```

They load `worker.js` directly, with in-memory buckets and stubbed calls to
Cloudflare, and check the bucket fence, CORS, the write gates (token, allowed
sites, IP fence), all three upload modes, paged listing, and the image routes.

**Live checks** hit the real Worker. They check that uploads without the token,
or with a wrong one, are refused. Given the token, they also do a real upload and
delete in `BUCKET1`:

```sh
WRITE_TOKEN=... ./test.sh                  # the deployed Worker
BASE=http://localhost:8787 ./test.sh       # a local wrangler dev
IMAGE_ID=... ./test.sh                     # also the /image routes
```

## Running and deploying

```sh
npm install
npx wrangler dev        # local server on http://localhost:8787
npx wrangler deploy     # publish to flare.tangent.workers.dev
```

Deploying needs a Cloudflare login (`npx wrangler login`). The Worker needs two
secrets, set once:

```sh
npx wrangler secret put CLOUDFLARE_IMAGE_TOKEN    # Cloudflare Images API token
npx wrangler secret put WRITE_TOKEN               # what uploads and deletes must present
```

For `wrangler dev`, put both in a `.dev.vars` file (it's git-ignored).

Merging to `main` does **not** deploy by itself. Run `npx wrangler deploy`
after merging.
