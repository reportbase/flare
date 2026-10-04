#!/usr/bin/env bash
# flare test ladder — each rung proves one thing.
#   ./test.sh                          # against the deployed component
#   BASE=http://localhost:8787 ./test.sh   # against wrangler dev
#   IMAGE_ID=ca8c5348-1541-4627-ec17-61970cd7aa00 ./test.sh            # also test the /image routes
#   WRITE_TOKEN=... ./test.sh          # the write checks need the Worker's write token
set -u
BASE="${BASE:-https://flare.tangent.workers.dev}"
BUCKET="${BUCKET:-BUCKET1}"
AUTH=(-H "Authorization: Bearer ${WRITE_TOKEN:-}")
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  pass  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "flare @ $BASE"

echo "· reads"
body=$(curl -s "$BASE/bucket?bucket=$BUCKET")
echo "$body" | grep -q '"success": *true' && ok "list $BUCKET" || bad "list $BUCKET -> $(echo "$body" | head -c 120)"
KEY=$(echo "$body" | grep -o '"name": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//')
if [ -n "$KEY" ]; then
  [ "$(code "$BASE/bucket?bucket=$BUCKET&key=$KEY")" = 200 ] && ok "get object ($KEY)" || bad "get object ($KEY)"
  curl -s "$BASE/bucket?bucket=$BUCKET&key=$KEY&meta=true" | grep -q '"success": *true' && ok "object meta" || bad "object meta"
else
  echo "  skip  object get/meta ($BUCKET is empty)"
fi

echo "· fence"
resp=$(curl -s "$BASE/bucket?bucket=NOTABUCKET")
[ "$(code "$BASE/bucket?bucket=NOTABUCKET")" = 404 ] && ok "unknown bucket -> 404" || bad "unknown bucket status"
echo "$resp" | grep -q 'availableBuckets' && bad "404 leaks binding names" || ok "404 leaks nothing"

echo "· CORS"
curl -sI "$BASE/bucket?bucket=$BUCKET" | grep -qi '^access-control-allow-origin: \*' && ok "reads are public (*)" || bad "read CORS header"
[ "$(code -X OPTIONS "$BASE/bucket" -H 'Origin: https://tangent.fit')" = 204 ] && ok "preflight 204" || bad "preflight"

echo "· writes"
TKEY="test/flare-test-$$.txt"
echo "flare test $$" > /tmp/flare-test.txt
[ "$(code -X POST "$BASE/bucket?bucket=$BUCKET&key=$TKEY" -F "file=@/tmp/flare-test.txt")" = 403 ] \
  && ok "no token -> 403" || bad "an upload without the token was not refused"
[ "$(code -X POST "$BASE/bucket?bucket=$BUCKET&key=$TKEY" -F "file=@/tmp/flare-test.txt" -H 'Authorization: Bearer wrong')" = 403 ] \
  && ok "wrong token -> 403" || bad "an upload with a wrong token was not refused"
if [ -n "${WRITE_TOKEN:-}" ]; then
  curl -s -X POST "$BASE/bucket?bucket=$BUCKET&key=$TKEY" "${AUTH[@]}" -F "file=@/tmp/flare-test.txt" | grep -q '"success": *true' \
    && ok "upload with the token" || bad "upload with the token (IP fence armed and you are not on it?)"
  curl -s "$BASE/bucket?bucket=$BUCKET&key=$TKEY" | grep -q "flare test $$" && ok "round-trip content" || bad "round-trip content"
  [ "$(code -X POST "$BASE/bucket?bucket=$BUCKET&key=$TKEY" -F "file=@/tmp/flare-test.txt" -H 'Origin: https://evil.example')" = 403 ] \
    && ok "foreign origin -> 403" || bad "foreign origin not rejected"
  curl -s -X DELETE "$BASE/bucket?bucket=$BUCKET&key=$TKEY" "${AUTH[@]}" | grep -q '"success": *true' && ok "delete with the token" || bad "delete"
  [ "$(code "$BASE/bucket?bucket=$BUCKET&key=$TKEY")" = 404 ] && ok "deleted is gone" || bad "deleted still present"
else
  echo "  skip  set WRITE_TOKEN=... to test uploading and deleting"
fi

echo "· images"
if [ -n "${IMAGE_ID:-}" ]; then
  [ "$(code "$BASE/image?image_id=$IMAGE_ID&v=1024x1024")" = 200 ] && ok "variant via delivery" || bad "variant (hash? variant name?)"
  [ "$(code "$BASE/image?blob=$IMAGE_ID")" = 200 ] && ok "blob via Images API" || bad "blob (CLOUDFLARE_IMAGE_TOKEN set? read perm?)"
else
  echo "  skip  set IMAGE_ID=... to test /image routes"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
