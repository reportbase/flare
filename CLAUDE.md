# flare: notes for Claude

The Cloudflare Worker at https://flare.tangent.workers.dev: reads and writes files
in R2 buckets and serves Cloudflare Images. games and draw read from it. The owner
works through Claude Code: changes go on a branch, as a PR, and the owner merges.

## Deploying happens on merge
Merging to `main` deploys the Worker: the "Deploy" workflow runs the unit tests,
then `wrangler deploy`, using the `CLOUDFLARE_API_TOKEN` repository secret. If
that secret is missing, the deploy is skipped with a warning. The owner can still
deploy by hand with `npx wrangler deploy`. A broken `main` is a broken live
Worker, so run `npm test` before every PR.

## Files
- `worker.js`: the whole Worker. It has two routes, `/bucket` and `/image`; the
  header comment lists every request it answers.
- `wrangler.toml`: the bindings and vars:
  - one `[[r2_buckets]]` binding per bucket, and `BUCKETS`, the list of
    bindings a request may reach (currently `BUCKET1`, `BUCKET2`, `SVG`,
    `REPORTBASE`); a new bucket needs both
  - `ALLOWED_ORIGINS`, `ALLOW_ORIGIN_WRITES`, `ALLOWED_WRITE_IPS`
- Secrets, set with `wrangler secret put` and never in the repo:
  - `CLOUDFLARE_IMAGE_TOKEN`
  - `WRITE_TOKEN`

## The rules that matter
- **Reads are public. Writes need permission** (`writeDenied`): the
  `Authorization: Bearer <WRITE_TOKEN>` header, or a browser page on
  `ALLOWED_ORIGINS` while `ALLOW_ORIGIN_WRITES` is `"true"`. That second route is
  a transition for tangent.fit; the plan is to set it to `"false"` once
  tangent.fit sends the token. Don't loosen the write gate.
- `?bucket=` only reaches bindings listed in `BUCKETS` (`bucketOf`). The env also
  holds secrets, so never index `env` with user input directly.
- Keep the response shapes stable; games, draw and tangent.fit depend on them.

## Testing
- `npm test`: unit tests in `tests/worker.test.mjs`, run with Node's own test
  runner. They use in-memory buckets and stubbed fetches, and need no install.
  Run them before every PR, and add tests for any change to the gates or routes.
- `test.sh`: live checks against the deployed Worker, or against
  `wrangler dev`, which works offline with local R2:
  1. put `WRITE_TOKEN=…` in a `.dev.vars` file (it's git-ignored)
  2. `npx wrangler dev`
  3. `BASE=http://localhost:8787 WRITE_TOKEN=… ./test.sh`

## Related repos
- **games** and **draw** read from flare.
- **3d** and **wander** don't use it.
