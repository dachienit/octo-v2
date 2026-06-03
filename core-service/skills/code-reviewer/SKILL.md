---
name: code-reviewer
description: Specialized code review using a fine-tuned model via HTTP API. Use when the user asks for a code review, security audit, or quality check on a file or code snippet. Returns structured feedback: bugs, security issues, style suggestions.
---

# Code Reviewer

Calls a specialized code-review model via HTTP API and returns structured feedback.

## Configuration

Set the endpoint and API key in the environment (or in `.env`):

```bash
export CODE_REVIEW_API_URL="https://your-model-server/v1/review"
export CODE_REVIEW_API_KEY="your-key-here"
```

Or pass them inline when calling the script.

## Usage

```bash
# Review a file
{baseDir}/review.sh path/to/file.ts

# Review code piped from stdin
cat myfile.py | {baseDir}/review.sh -

# Review with a specific focus
{baseDir}/review.sh path/to/file.ts --focus security
{baseDir}/review.sh path/to/file.ts --focus performance
{baseDir}/review.sh path/to/file.ts --focus style
```

## Output

The script prints a JSON object:
```json
{
  "summary": "Overall assessment",
  "issues": [
    { "line": 42, "severity": "error|warning|info", "category": "bug|security|style|performance", "message": "..." }
  ],
  "score": 87
}
```

Parse it, then present the findings clearly to the user grouped by severity.

## Example Workflow

1. Read the file the user wants reviewed
2. Run `{baseDir}/review.sh <path>`
3. Parse the JSON output
4. Present findings grouped as: Errors → Warnings → Suggestions
5. Offer to fix any specific issue if asked
