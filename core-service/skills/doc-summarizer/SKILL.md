---
name: doc-summarizer
description: Summarize long documents, PDFs, or text files using a specialized summarization model via HTTP API. Use when the user wants a TL;DR, key points, or executive summary of a large file or pasted text. Supports focus modes: general, action-items, technical, executive.
---

# Document Summarizer

Sends a document to a specialized summarization HTTP API and returns structured output.

## Configuration

```bash
export DOC_SUMMARY_API_URL="https://your-model-server/v1/summarize"
export DOC_SUMMARY_API_KEY="your-key-here"
```

## Usage

```bash
# Summarize a file
{baseDir}/summarize.sh path/to/document.txt

# Summarize with a focus
{baseDir}/summarize.sh report.pdf --mode executive
{baseDir}/summarize.sh meeting-notes.txt --mode action-items
{baseDir}/summarize.sh paper.md --mode technical

# Pipe text in
cat long-email.txt | {baseDir}/summarize.sh -
```

## Modes

| Mode | Output |
|------|--------|
| `general` | Short paragraph + key points (default) |
| `executive` | 3-sentence summary for decision makers |
| `action-items` | Bulleted list of tasks/decisions |
| `technical` | Technical details, methods, conclusions |

## Output

```json
{
  "summary": "One paragraph overview",
  "key_points": ["point 1", "point 2"],
  "action_items": ["task 1"],
  "word_count_original": 4200,
  "word_count_summary": 120
}
```

## Example Workflow

1. User shares a file or pastes text
2. Run `{baseDir}/summarize.sh <path> --mode <mode>`
3. Present the summary in a clean format
4. Offer to go deeper on any section
