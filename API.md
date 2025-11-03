### API: next_word_prediction (for LLM consumers)

- **Endpoint**: POST `/api:call` or `/api/call`
- **Content-Type**: `application/json`
- **Mode**: `"next_word_prediction"`

You may send either:
- A top-level object with `json` property (recommended), or
- A plain JSON body (no wrapper). The server accepts both.

### Request schema
- **Required**:
  - **mode**: `"next_word_prediction"`
- **Inputs** (aliases supported):
  - **preceding text**: `precedingText` | `preceding_text` (string)
  - **prefix for next word**: `prefixText` | `prefix` (string; can be empty)
  - **context**: `speechContent` | `context` | `speech_content` (string; optional)
  - **conversation history**: `SpeechHistory` | `speechHistory` | `history` (string; optional)

### Response schema (success)
- `json.predictions`: array of 10 objects `{ word: string, probability: number }` (probabilities sum to ~1)
- `json.result`: `"SUCCESS"`
- `json.modelUsed`: string (e.g., `"openai:gpt-4o-mini"`) or `"heuristic"`
- `json.source`: `"llm"` or `"heuristic"`
- `json.llmError`: string | null
- `json.contextualPhrases`: array (currently `[]`)

### Example request (wrapped in `json`)
```bash
curl -s -X POST http://localhost:8081/api:call \
  -H 'Content-Type: application/json' \
  -d '{
    "json": {
      "mode": "next_word_prediction",
      "precedingText": "I need",
      "prefixText": "to",
      "speechContent": "shopping list and errands today",
      "SpeechHistory": "I need to buy milk and bread"
    }
  }'
```

### Example response
```json
{
  "json": {
    "predictions": [
      { "word": "to", "probability": 0.22 },
      { "word": "take", "probability": 0.15 },
      { "word": "try", "probability": 0.13 },
      { "word": "tell", "probability": 0.11 },
      { "word": "think", "probability": 0.1 },
      { "word": "turn", "probability": 0.08 },
      { "word": "talk", "probability": 0.07 },
      { "word": "takeout", "probability": 0.06 },
      { "word": "takeaway", "probability": 0.05 },
      { "word": "today", "probability": 0.03 }
    ],
    "result": "SUCCESS",
    "modelUsed": "openai:gpt-4o-mini",
    "source": "llm",
    "llmError": null,
    "contextualPhrases": []
  }
}
```

### Notes for LLM callers
- Always include `"mode": "next_word_prediction"`.
- Provide as much context as available (`precedingText`, `prefixText`, `SpeechHistory`, `speechContent`) to improve results.
- If you can’t send the `json` wrapper, send the same fields directly as the root body; the server accepts both shapes.
- Consume `json.predictions` for probabilities; this is the authoritative list of candidates.


