#!/usr/bin/env bash
# summarize.sh — Call specialized document summarization HTTP API
# Usage: summarize.sh <file_path_or_-> [--mode general|executive|action-items|technical]
set -euo pipefail

API_URL="${DOC_SUMMARY_API_URL:-http://localhost:8000/v1/summarize}"
API_KEY="${DOC_SUMMARY_API_KEY:-}"
MODE="general"
FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    *) FILE="$1"; shift ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo '{"error": "No input. Usage: summarize.sh <path_or_-> [--mode general|executive|action-items|technical]"}' >&2
  exit 1
fi

# Read content
if [[ "$FILE" == "-" ]]; then
  CONTENT=$(cat)
else
  if [[ ! -f "$FILE" ]]; then
    echo "{\"error\": \"File not found: $FILE\"}" >&2
    exit 1
  fi
  CONTENT=$(cat "$FILE")
fi

WORD_COUNT=$(echo "$CONTENT" | wc -w | tr -d ' ')

MODE_INSTRUCTION=""
case "$MODE" in
  executive)    MODE_INSTRUCTION="Write a 3-sentence executive summary for a decision-maker. No jargon." ;;
  action-items) MODE_INSTRUCTION="Extract all action items, decisions, and tasks as a JSON array in action_items." ;;
  technical)    MODE_INSTRUCTION="Focus on technical details, methods, data, and conclusions." ;;
  *)            MODE_INSTRUCTION="Write a general summary with key points." ;;
esac

PAYLOAD=$(jq -n \
  --arg content "$CONTENT" \
  --arg mode "$MODE" \
  --arg instruction "$MODE_INSTRUCTION" \
  --argjson wc "$WORD_COUNT" \
  '{
    model: "summarizer-v1",
    messages: [
      {
        role: "system",
        content: ("You are a document summarizer. " + $instruction + " Always respond with valid JSON: {\"summary\": \"...\", \"key_points\": [], \"action_items\": [], \"word_count_original\": " + ($wc | tostring) + ", \"word_count_summary\": 0}")
      },
      {
        role: "user",
        content: $content
      }
    ],
    response_format: { type: "json_object" }
  }')

RESPONSE=$(curl -sf \
  -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  ${API_KEY:+-H "Authorization: Bearer $API_KEY"} \
  -d "$PAYLOAD")

echo "$RESPONSE" | jq -r '.choices[0].message.content // .'
