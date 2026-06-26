# Architecture

## Why the diff is computed in code, not by the model

It would be possible to hand both raw SR tables to an LLM and ask it to "find the differences." This project deliberately does not do that, for two reasons:

1. **Correctness.** Diffing structured records by key is a solved, deterministic problem. Code will never hallucinate a changed quantity or miss a removed part number. Reserving the model for what code cannot do (judging *why* a change matters and *what* to ask about it) keeps the system reliable where it needs to be reliable, and useful where judgment actually helps.
2. **Cost and latency.** Sending only the computed diff (a handful of lines) instead of two full SR tables keeps the prompt small regardless of how many hundreds of part numbers are in a given week's SR.

## Data flow

1. **Parsing** (`parseSR`) — Raw pasted text (tab- or comma-separated) is split into rows, with optional header-row detection based on column-name keywords. Each row is normalized into a fixed-shape object keyed by `part_number`.

2. **Diffing** (`diffSRs`) — Two parsed tables are compared by building lookup maps keyed on `part_number`:
   - **Added:** present in current week, absent in previous week
   - **Removed:** present in previous week, absent in current week
   - **Changed:** present in both, with one or more fields (`cm_location`, `type`, `date`, `qty`, `product_code`, `platform`) differing

3. **Prompt construction** — The diff (not the raw tables) is serialized into a compact text block: row counts, and explicit added/removed/changed lists with before → after values for changed fields.

4. **Model call** — The diff text is sent to the Claude API with a system prompt that:
   - Scopes the model to a supply chain analyst persona
   - Defines the exact JSON schema expected back (summary, key_themes, questions_for_demand_planning, questions_for_cms, risk_flags)
   - Constrains string length to keep the response well within the token budget and avoid truncated JSON

5. **Rendering** — The deterministic diff (change log table, added/removed/changed counts) and the model's reasoning output (summary, themes, risks, questions) are rendered as two distinct sections, so a reader can always tell what was computed versus what was inferred.

## Known limitations

- **Part-number-only keying.** If the same part number is reused across different platforms in a way that should be treated as a distinct line item, the current diff logic will conflate them. A composite key (`part_number` + `platform`) is a likely future fix if this comes up.
- **No persistence.** Each run is stateless. There is no history of prior weeks' diffs to detect recurring patterns (e.g., a CM consistently slipping commit dates).
- **Client-side API calls.** The current implementation calls the Anthropic API directly from the frontend. This is safe inside the Claude.ai Artifacts sandbox (where the call is proxied and authenticated by the platform) but is **not** safe in a standalone deployment with a real API key. A production version should route this call through a backend service that holds the key server-side.

## Suggested backend proxy (for standalone deployment)

A minimal Node/Express proxy to keep the API key server-side:

```js
// server.js
import express from "express";
const app = express();
app.use(express.json());

app.post("/api/reconcile", async (req, res) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(req.body)
  });
  const data = await response.json();
  res.json(data);
});

app.listen(3001);
```

The frontend would then call `/api/reconcile` instead of the Anthropic endpoint directly, and the key never reaches the browser.
