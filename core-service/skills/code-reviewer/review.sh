#!/usr/bin/env bash
# review.sh — Call specialized code-review HTTP API
# Usage: review.sh <file_path_or_-> [--focus security|performance|style]
set -euo pipefail

API_URL="${CODE_REVIEW_API_URL:-http://localhost:8000/v1/review}"
API_KEY="${CODE_REVIEW_API_KEY:-}"
FOCUS="general"

FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --focus) FOCUS="$2"; shift 2 ;;
    *) FILE="$1"; shift ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo '{"error": "No file specified. Usage: review.sh <path_or_-> [--focus security|performance|style]"}' >&2
  exit 1
fi

# Read code — from file or stdin
if [[ "$FILE" == "-" ]]; then
  CODE=$(cat)
  FILENAME="stdin"
else
  if [[ ! -f "$FILE" ]]; then
    echo "{\"error\": \"File not found: $FILE\"}" >&2
    exit 1
  fi
  CODE=$(cat "$FILE")
  FILENAME=$(basename "$FILE")
fi

# Build JSON payload
PAYLOAD=$(jq -n \
  --arg code "$CODE" \
  --arg filename "$FILENAME" \
  --arg focus "$FOCUS" \
  '{
    model: "code-reviewer-v1",
    messages: [
      {
        role: "user",
        content: ("Review this code for " + $focus + " issues.\nFilename: " + $filename + "\n\n```\n" + $code + "\n```\n\nRespond with valid JSON: {\"summary\": \"...\", \"issues\": [{\"line\": 0, \"severity\": \"error|warning|info\", \"category\": \"bug|security|style|performance\", \"message\": \"...\"}], \"score\": 0}")
      }
    ],
    response_format: { type: "json_object" }
  }')

# Call the API
AUTH_HEADER=""
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER="-H \"Authorization: Bearer $API_KEY\""
fi

RESPONSE=$(curl -sf \
  -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "Authorization: Bearer $API_KEY"} \
  -d "$PAYLOAD")

# Extract the content from OpenAI-compatible response
echo "$RESPONSE" | jq -r '.choices[0].message.content // .'
