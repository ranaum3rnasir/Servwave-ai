#!/bin/bash
# Raw transcript generator. Every request below is re-run at capture time.
REF=knriiqdqxgfoecsfarlx
SIGNED=https://$REF.storage.supabase.co/storage/v1/upload/resumable/sign
PLAIN=https://$REF.storage.supabase.co/storage/v1/upload/resumable
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
META="bucketName $(b64 attachments),objectName $(b64 probe/does-not-exist.mp4),contentType $(b64 video/mp4),cacheControl $(b64 3600)"
LOC="$SIGNED/YXR0YWNobWVudHMvcHJvYmUvbm90LWEtcmVhbC11cGxvYWQ"

run() { # label, then curl args
  local label="$1"; shift
  echo "--- $label"
  echo -n "    "; curl -s -w 'HTTP %{http_code}  body: ' -o /tmp/claude-501/_b "$@" --max-time 25; cat /tmp/claude-501/_b; echo
}

echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')  project: $REF (staging)"
echo
echo "== creation (POST) =="
run "signed route, valid Upload-Metadata, NO x-signature" -X POST "$SIGNED" -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 8388608" -H "Upload-Metadata: $META"
run "signed route, valid Upload-Metadata, malformed x-signature" -X POST "$SIGNED" -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 8388608" -H "Upload-Metadata: $META" -H "x-signature: not-a-real-token"
run "signed route, NO Upload-Metadata" -X POST "$SIGNED" -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 8388608"
run "UNSIGNED route, same presigned-shaped request" -X POST "$PLAIN" -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 8388608" -H "Upload-Metadata: $META" -H "x-signature: not-a-real-token"
echo
echo "== transfer (PATCH) on an upload id that never existed =="
run "signed route, NO x-signature" -X PATCH "$LOC" -H "Tus-Resumable: 1.0.0" -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" --data-binary "x"
run "signed route, malformed x-signature" -X PATCH "$LOC" -H "Tus-Resumable: 1.0.0" -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" -H "x-signature: not-a-real-token" --data-binary "x"
echo
echo "== capability advertisement (OPTIONS) =="
echo "--- signed route"; curl -s -o /dev/null -D - -X OPTIONS "$SIGNED" -H "Tus-Resumable: 1.0.0" --max-time 25 | tr -d '\r' | grep -iE '^HTTP|^tus-|^allow' | sed 's/^/    /'
echo "--- unsigned route"; curl -s -o /dev/null -D - -X OPTIONS "$PLAIN" -H "Tus-Resumable: 1.0.0" --max-time 25 | tr -d '\r' | grep -iE '^HTTP|^tus-|^allow' | sed 's/^/    /'
echo
echo "== hostname =="
echo "--- dig $REF.storage.supabase.co"; dig +short $REF.storage.supabase.co | sed 's/^/    /'
