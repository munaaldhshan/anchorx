# AI Focus Coach (backend)

A chat coach that answers questions about the signed-in user's own focus data. This page covers the backend only: `backend/services/coach/`, `backend/routes/coach.js` and `backend/models/CoachConversation.js`.

## How a turn works

1. The user's message arrives at `POST /api/ai/coach/conversations/:id/messages`.
2. `runCoachTurn` asks the model for a **step**, a JSON object validated by zod through `llm/generate()`:
   - `{"action":"call_tool","toolCall":{"name","arguments":"<JSON string>"}, …}`, or
   - `{"action":"answer","sections":[{"kind","text"}],"dataGaps":[…], …}`.
3. For `call_tool`, the server validates the arguments against that tool's strict zod schema. It then runs the tool for the **authenticated** user and sends the result back as a `TOOL_RESULT` message.
4. Steps repeat until the model answers. There are at most **4 tool calls per turn**, and repeated calls count. After the 4th, any further `call_tool` fails validation, so a turn makes at most 5 successful model steps.
5. The answer is stored and returned. Measured sections come first, then suggestions.

Tool calling is done through structured output rather than provider-native function calling. That way the existing provider chain (fast tier: Gemini 3.5 Flash-Lite, then GitHub gpt-4.1-mini), rate limits, the per-user daily quota and the corrective retry all apply unchanged. No provider adapters were modified.

## Data tools (read-only)

| Tool | Arguments | Returns |
|---|---|---|
| `getSessionsByRange` | `from`, `to`, `limit?` (1–50) | Ended sessions: date, local start time, status, mode, planned/focus minutes, score |
| `getDailyAggregates` | `from`, `to` | Per day: focus minutes, completed, abandoned, average score |
| `getHourlyAverages` | `from`, `to` | Per local start hour: sessions, average minutes, average score |
| `getStreak` | — | Current and longest streak, in days |
| `getDistractionStats` | `from`, `to` | Distraction totals by type, top 5 apps. Events during breaks are excluded |

- **Identity.** It comes only from `toolContextFor(req.user)`. The argument schemas are `.strict()`, so a model-supplied `userId` or any unknown key is rejected. Every query filters on that user's id.
- **Dates.** Real `YYYY-MM-DD` local dates, with `from ≤ to`, at most 92 days, not in the future and not before 2020-01-01.
- **Minimal output.** Results contain no ids, session titles, category names or account fields.
- **Errors.** Bad input becomes a tool error that is sent to the model. It never throws to the client.

## Answer rules and validation

The system prompt requires: numbers only from tool results, plain statements of missing data in `dataGaps`, associations rather than causal claims, and `measured_data` kept separate from `ai_suggestion`.

The server enforces the number rule in `grounding.js`, through the `check` option on `generate()`:

- **`measured_data` sections.** Every number must appear in this turn's tool results, an earlier measured answer, or the reference date.
- **`ai_suggestion` sections and `dataGaps`.** Numbers may also come from the user's own messages. A figure the user typed can be echoed in a suggestion but never presented as measured.
- **Accepted derivations.** Rounding, and converting minutes to hours.

When a step fails validation (zod or grounding), the model gets one corrective retry with the error. The next provider is tried after that. If all providers fail, the reply is `status: "unavailable"` with a fixed notice. Unvalidated model text is never returned or stored.

## Endpoints

All endpoints are under `/api/ai/coach` and require a Bearer token. Every lookup is scoped to `{ _id, userId }`. A conversation that belongs to someone else returns 404, the same as one that doesn't exist.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/conversations` | — | List, newest first, without messages |
| `POST` | `/conversations` | `{ message? }` | Start a conversation. With `message`, also runs the first turn. Max 50 per user (409) |
| `GET` | `/conversations/:id` | — | Full history |
| `POST` | `/conversations/:id/messages` | `{ message }` (1–1000 chars) | Runs a turn and returns `{ reply }`. Max 100 messages per conversation (409) |
| `PUT` | `/conversations/:id/messages/:messageId/feedback` | `{ rating: "up" \| "down" \| null }` | Assistant messages only |
| `DELETE` | `/conversations/:id` | — | Delete a conversation |

Unknown body fields return 400. The send and start endpoints are limited to 10 per minute per user, which is skipped in tests.

Assistant message shape:

```json
{ "id": "…", "role": "assistant", "status": "ok",
  "sections": [{ "kind": "measured_data", "text": "…" }, { "kind": "ai_suggestion", "text": "…" }],
  "dataGaps": ["…"], "feedback": null, "createdAt": "…" }
```

When `status` is `"unavailable"`, `sections` is empty and the message adds `unavailableReason` (`daily_limit` or `service_unavailable`) and a `notice`.

**What is never stored or returned:** the system prompt, tool arguments and results, raw model output, and provider or model names. Account deletion (`DELETE /api/user/me`) removes the user's conversations.

## Cost and config

There are no new environment variables. Each model step counts as one call against `AI_DAILY_LIMIT`, so one turn uses 1–5 calls, or more when a corrective retry is needed.
