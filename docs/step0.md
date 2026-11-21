# Step 0: foundation

Four foundation pieces that later feature work builds on: time handling, the focus event model, session durations, and the LLM layer.

## 1. Time and timezones

**Rule:** every instant is stored as a UTC `Date`. A *day* is always a user-local calendar date (`YYYY-MM-DD`), worked out from an instant plus an IANA zone. Only `backend/utils/datetime.js` does that conversion.

| Helper | Use |
|---|---|
| `resolveTimezone(userOrTz)` | Returns the zone to bucket by (`settings.timezone`). Invalid or missing values become `UTC`. |
| `localDayOf / localHourOf / localWeekdayOf(date, tz)` | Day, hour, and weekday buckets. |
| `localDayStartUtc(dateStr, tz)`, `localDayRangeUtc(dateStr, tz)` | `[start, end)` UTC instants for one local day. DST-aware: days can be 23h or 25h. |
| `formatLocalHHMM(date, tz)` | Display only. |
| `userTodayStr`, `shiftDateStr`, `diffDays`, `weekdayOfDateStr` | Arithmetic on `YYYY-MM-DD` strings. |

Never call `Date#getHours`, `getDay`, or `setHours` on the server. They read the server's own zone, which is UTC on Render.

- **Where the zone comes from.** `User.settings.timezone`, which the app syncs from the device at launch. Each session also stores the `timezone` it ran in, from the client's `timezone` field.
- **Which day a session counts toward.** The local day of `startedAt` in the session's zone, decided on the server (`resolveSessionDay`). Older app builds send only a device-local `dateStr`. It is trusted if it is within ±1 day of the derived value; otherwise the derived value wins. A session that crosses midnight counts toward the day it started.
- **Bugs fixed.** AI insights and the dashboard tip bucketed hours and weekdays in server time. Every non-UTC user therefore got a shifted "best hour". Their 30-day and 7-day windows are now local-day windows.

## 2. Focus event model

`backend/constants/focusEvents.js` is the single definition, stored in `FocusLog.event`.

| Event | Meaning | Written by |
|---|---|---|
| `SESSION_STARTED` / `SESSION_ENDED` | Lifecycle. `metadata.reason` is `COMPLETED` or `ABANDONED`. | Server |
| `NFC_VERIFIED` / `NFC_REJECTED` | Tag check-in. `metadata.tagUid` holds the tag ID. | Server |
| `APP_BLOCKED` | A block was **enforced**: the user tried to open a shielded app and the shield stopped them. | Client |
| `DISTRACTION` | A distraction was **detected** that no shield stopped. | Client |
| `BREAK_STARTED` / `BREAK_ENDED` | Pomodoro breaks. | Client |

- **One occurrence produces exactly one event.** A blocked attempt is logged as `APP_BLOCKED` only. Distraction total = `APP_BLOCKED` + `DISTRACTION` (`DISTRACTION_EVENTS`, `FocusLog.countDistractions`). That total drives the focus score, the `distractionCount` returned by `/end`, and the AI "top distractions" list.
- **"Top blocked app".** `Statistics.topBlockedApp` counts `APP_BLOCKED` only.
- **Metadata.** Allowed keys are `appName`, `packageName` (bundle ID, preferred as the app key), `reason`, `source` (`shield | app_state | manual | system`), and `tagUid`. Unknown keys are dropped.
- **`POST /api/sessions/:id/log`.** Accepts client events only, and only while the session is `ACTIVE` (otherwise 409). An optional client `timestamp` is kept if it falls inside the session window.

**What the mismatch was.** The AI service queried `DISTRACTION`, but the enum rejected it. Scoring counted only `APP_BLOCKED`. Nothing in the app ever posted either event. The "Distractions" figure on the session-complete screen was invented on the client (`floor(min/20)+…`) and disagreed with the server score. The NFC uid was silently dropped.

**Data migration.** None was needed. The enum always rejected `DISTRACTION`, and no client wrote `APP_BLOCKED`, so no stored rows need rewriting.

**Still open.** Nothing *produces* `APP_BLOCKED` or `DISTRACTION` yet. On iOS that needs a ShieldAction extension (for `APP_BLOCKED`) and an app-state heuristic (for `DISTRACTION`). Until then, the count shown is a truthful 0.

## 3. Planned vs actual duration

Source of truth: top-level `Session.plannedDurationSec` and `Session.actualDurationSec`, as integer **seconds**.

- **`plannedDurationSec`.** Set at creation. For Pomodoro it is focus time, excluding breaks.
- **`actualDurationSec`.** Set at `/end` as `min(client-measured focus seconds, endedAt − startedAt + 60s skew)`. If the client sends no figure, it is `endedAt − startedAt`. It is `null` while a session is `ACTIVE` or `PENDING`. Pauses and breaks are excluded, because a wall-clock-only value would over-count them. The wall-clock bound stops it from ever exceeding real time.
- **Reading.** Always use `plannedSecOf(doc)`, `actualSecOf(doc)`, or `actualMinutesOf(doc)` from `models/Session.js`. They fall back to the legacy minute fields for rows the migration has not reached yet.
- **Legacy fields.** `timerConfig.plannedDuration` and `timerState.actualDuration` (minutes) are still **dual-written** for one release, so a backend rollback stays safe. They are not read. A later migration can `$unset` them.
- **API.** Session records now include `plannedDurationSec` and `actualDurationSec`. `duration` and `plannedDuration` stay as minutes for existing app builds. The endpoints still accept the legacy minute inputs.
- **Aggregates.** `Statistics.totalFocusMinutes` and the analytics bars sum seconds and round once.

**Migration `001-session-duration-seconds`** (`backend/migrations/`) is additive and idempotent:

- `plannedDurationSec` = legacy planned minutes × 60, or `null`.
- `actualDurationSec`:
  - `null` for any status other than `COMPLETED` or `ABANDONED`.
  - Otherwise, legacy actual minutes × 60 when > 0. These values are deliberately not clamped, so stored Statistics don't shift.
  - Otherwise, `endedAt − startedAt` when both exist and are ordered.
  - Otherwise, `null`.

Migrations run on boot unless `RUN_MIGRATIONS_ON_BOOT=false`, or manually with `npm run migrate`. Applied IDs are recorded in `_migrations`.

## 4. LLM layer: `generate(messages, task)`

`backend/llm/` is the only code that talks to a model. Services import from `llm/index.js`.

```js
import { generate, defineTask } from '../llm/index.js';

const TASK = defineTask({
  name: 'focus_tip',                       // also the structured-output schema name
  schema: z.object({ tip: z.string().min(10).max(280) }),
  fallback: (ctx) => ({ tip: `…from ${ctx.bestHour}…` }),  // deterministic, offline
  safeDefault: { tip: 'Start a 25-minute session.' },      // must pass the schema
  temperature: 0.4, maxTokens: 256,
});

const { data, meta } = await generate(messages, TASK, { context: stats });
// meta: { source: 'llm'|'fallback', provider, model, task, attempts,
//         latencyMs, usage, fallbackUsed, reason, degraded }
```

How a call is handled:

1. **Walk the chain.** Try each `{provider, model}` in order. Providers without credentials are skipped.
2. **Rate-limit locally.** Wait for a slot (requests/min and tokens/min), up to `LLM_QUEUE_TIMEOUT_MS`.
3. **Send with a timeout.** Each request is aborted after `LLM_TIMEOUT_MS`.
4. **Retry transient errors.** 429, 5xx, timeouts, and network errors are retried with exponential backoff and full jitter. `Retry-After` and Gemini `retryDelay` are respected, and a 429 also pauses that provider's limiter. If a wait would exceed `LLM_MAX_RETRY_WAIT_MS`, the chain moves on instead.
5. **Validate.** The reply is parsed as JSON and validated with zod. If it fails, the model gets **one corrective retry**, with the validation error fed back. If that also fails, the next provider is tried.
6. **Rule-based fallback.** If every provider fails, the task's `fallback(context)` runs. If it throws or returns invalid output, `safeDefault` is returned with `meta.degraded = true`. `generate()` never rejects because of a provider problem.

Providers receive a structural JSON Schema derived from zod: types, enums, required fields, nesting. Bounds are enforced by zod afterwards, because hosted structured-output modes reject many constraint keywords.

Every attempt is logged (pino) with task, provider, model, attempt, latency, status, and usage. A summary line is logged per call. `GET /api/health` → `ai` reports primary status, the chain, `fallbackCount`, and `ruleBasedCount`.

The UI can tell where an answer came from:

- `AIInsight.source`, `provider`, and `modelVersion` are stored. The Insights screen labels rule-based answers.
- `/api/ai/suggestion` returns `source`.
- Rule-based results are cached for a shorter time (insights 30 min, tips 10 min), so the LLM gets another chance soon.

### Config

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `openai` if `LLM_API_KEY` is set, else `gemini` if `GEMINI_API_KEY` is set | Primary provider ID |
| `LLM_MODEL` | `openai/gpt-4.1-mini` (openai), `GEMINI_MODEL` (gemini) | Primary model |
| `LLM_FALLBACKS` | `gemini:<GEMINI_MODEL>` if Gemini is configured and isn't primary | Comma list of `provider:model`, or `none` |
| `LLM_TIMEOUT_MS` | 20000 | Per-request timeout |
| `LLM_MAX_RETRIES` | 2 | Transient retries per provider |
| `LLM_MAX_RETRY_WAIT_MS` | 8000 | Longest single wait before moving on |
| `LLM_QUEUE_TIMEOUT_MS` | 5000 | Longest wait for a local rate-limit slot |
| `LLM_RPM_<ID>` / `LLM_TPM_<ID>` | openai 15 / 0, gemini 10 / 250000 | Per-provider limits (0 = unlimited) |
| `LLM_API_KEY`, `LLM_BASE_URL` | GitHub Models URL | `openai` provider (any OpenAI-compatible host) |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BASE_URL`, `GEMINI_THINKING_BUDGET` | `gemini-2.5-flash`, v1beta, `0` | `gemini` provider. Set the thinking budget to `''` to omit it. |

Default model names live only in `llm/config.js`. The existing Render env (`LLM_API_KEY`, `LLM_MODEL`, `GEMINI_*`) works unchanged.

### Add a provider

1. Create `llm/providers/<id>.js` exporting `{ id, isConfigured(), complete({ model, messages, jsonSchema, schemaName, temperature, maxTokens, signal }) → { text, usage: { inputTokens, outputTokens } } }`. Throw `LLMError` with `status` and `retryAfterMs` so the retry logic can classify the failure.
   - For an OpenAI-compatible host, this is a single call: `createOpenAICompatibleProvider({ id, apiKeyEnv, baseUrlEnv, defaultBaseUrl })`.
2. Register it in `llm/providers/index.js`.
3. Reference it in `LLM_PROVIDER` or `LLM_FALLBACKS`. Optionally set `LLM_RPM_<ID>` and `LLM_TPM_<ID>`.

### Add a rule-based backup

Pass `fallback` and `safeDefault` to `defineTask`. To override the fallback later, call `registerFallback('<task name>', (context) => …)`. The fallback receives the `context` passed to `generate()`. It must be pure and offline. Its output is validated against the task schema, so a bad return falls back to `safeDefault` rather than crashing.
