# Custom Breaks: API contract

Planned and on-demand breaks for **COUNTDOWN** and **STOPWATCH** sessions. Pomodoro keeps its own break cycle, and its client-logged `BREAK_*` events are unchanged. The server records every Custom Break's real start and end, so the allowance, focus time and temptation counts can't drift from what happened.

Backend: `backend/utils/breaks.js` and `backend/routes/sessions.js`. Tests: `backend/test/breaks.test.js`.

## Rules

- A `breakPlan` is accepted only for `COUNTDOWN` and `STOPWATCH` sessions. A plan on a `POMODORO` session returns 400.
- The planned duration (`plannedDurationSec`) counts **focus time only**. Breaks are added on top of it.
- A planned break's `startAfter` is measured in **focus minutes**, not wall-clock time. Pauses and earlier breaks don't move it. The client owns the focus clock, so the client decides when a planned break is due and calls start.
- The on-demand allowance is charged at the **requested** length when the break starts. Ending a break early gives nothing back.
- If `allowance` is left out, on-demand breaks are off for that session.
- A break can never run longer than its length. The server clamps its end to `startedAt + duration`.
- Only one break can be open at a time.
- A break whose time ran out without being closed (for example, because the app was killed) is closed automatically at its deadline the next time a break starts. It is also closed when the session ends.
- `actualDurationSec` (or the legacy `timerState.actualDuration`) sent on `/end` must be **focus time only**. The server clamps it to `wall-clock time − break time + 60s`.
- Distractions (`APP_BLOCKED` / `DISTRACTION`) that fall inside a break window don't count toward the focus score, the `distractionCount` returned by `/end`, or `topBlockedApp`.
- Breaks never lower the focus score. A session with breaks still counts toward streaks if it's COMPLETED.

## Create: `POST /api/sessions`

`timerConfig.breakPlan` is optional:

```json
{
  "planned":   [{ "startAfter": 45, "duration": 10 }],
  "allowance": { "maxBreaks": 2, "maxMinutes": 20 },
  "unlockAppsDuringBreak": false
}
```

| Field | Limits |
|---|---|
| `planned` | 0–10 breaks, sorted by `startAfter`, no duplicates |
| `planned[].startAfter` | An integer. COUNTDOWN: from 1 to the planned minutes − 1. STOPWATCH: from 1 to 480. |
| `planned[].duration` | 1–60 minutes |
| `allowance.maxBreaks` | 0–10, or `null` for no count limit |
| `allowance.maxMinutes` | 0–180, or `null` for no minutes limit. You must set at least one of `maxBreaks` and `maxMinutes`. |
| `unlockAppsDuringBreak` | A boolean, default `false`. The server only stores this flag; the app itself lifts the shield during the break. |

## Start a break: `POST /api/sessions/:id/breaks/start`

```json
{ "type": "PLANNED", "plannedIndex": 0 }
{ "type": "ON_DEMAND", "duration": 10 }
```
For a `PLANNED` break, the length always comes from the plan. For an `ON_DEMAND` break, `duration` must be 1–60 minutes.

| Status | `code` | When |
|---|---|---|
| 200 | – | The updated SessionRecord. `activeBreak` is now set. |
| 400 | – | Validation failed, the session has no `breakPlan`, or `plannedIndex` is out of range. |
| 403 | `ALLOWANCE_EXCEEDED` | The on-demand break would go over `maxBreaks` or `maxMinutes`. |
| 409 | `BREAK_ALREADY_OPEN` | Another break is in progress. |
| 409 | `PLANNED_BREAK_TAKEN` | That planned break was already taken. |
| 409 | `PLANNED_BREAK_NOT_DUE` | Less wall-clock time than `startAfter` has passed since the session started, with 60s of slack. |
| 409 | `SESSION_NOT_ACTIVE` | The session has already ended. |

## End a break: `POST /api/sessions/:id/breaks/end`

Body: `{ "endedAt"?: ISO }`. If you leave it out, the server uses the current time. The end is clamped between the break's start and the earlier of now and the break's deadline.

| Status | `code` | When |
|---|---|---|
| 200 | – | The updated SessionRecord. `activeBreak` is now `null`. |
| 409 | `NO_OPEN_BREAK` | No break is in progress. |
| 409 | `SESSION_NOT_ACTIVE` | The session has already ended. |

## End the session: `PATCH /api/sessions/:id/end`

This works as before. Any break still open is closed at `endedAt`. If two requests race, a break started at the same moment makes `/end` return 409, and the client should retry.

## New SessionRecord fields

Every session endpoint returns these fields:

```ts
breakPlan: {
  planned: { startAfter: number; duration: number }[];
  allowance: { maxBreaks: number | null; maxMinutes: number | null } | null;
  unlockAppsDuringBreak: boolean;
} | null;                       // null = no Custom Breaks
breaks: {
  type: 'PLANNED' | 'ON_DEMAND';
  plannedIndex: number | null;
  duration: number;             // minutes requested / planned
  startedAtISO: string;
  endedAtISO: string | null;    // null = in progress
  endedEarly: boolean;
}[];
activeBreak: Break | null;      // the open break, used to resume after an app kill
breakDurationSec: number;       // total break time, set at /end
breakMinutes: number;           // breakDurationSec rounded to minutes (for the summary)
breaksTaken: number;
allowanceRemaining: { breaks: number | null; minutes: number | null } | null;
                                // null fields = unlimited on that axis; {0,0} = on-demand off
```

## Focus log events

The server writes `BREAK_STARTED` and `BREAK_ENDED` for Custom Breaks, with `metadata.breakType` and `metadata.breakIndex`. On `BREAK_ENDED`, `metadata.reason` is `EARLY`, `ELAPSED` or `SESSION_ENDED`. Clients must not post `BREAK_*` events to `/log` for non-Pomodoro sessions; doing so returns 400.
