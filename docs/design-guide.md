# Klankish — Design Guide

**Written for:** whoever builds or extends the UI.
**Base system:** `dockito/design-system/projects/dipstick` — ledger broadsheet.

---

## Why dipstick, and why it wasn't close

The selection rule used across the design-system archive is: **pick the stance where the product's
loud differentiator is the native object** — not a metaphor stretched over a console.

Klankish's differentiator is not "it runs things on a schedule" (cron does that). It is **the run
record**: an immutable, timestamped, ordered account of what executed, what was sent, what came
back, and what the engine decided next. Every screen is either *looking at a record* or *composing
the definition that produces records*.

That is a **ledger**. Not a metaphor — a ledger is literally what this product keeps.

Dipstick is the ledger-broadsheet stance, and its idioms transfer with almost no stretching:

| Dipstick idiom | Klankish object |
|---|---|
| `.ledger` reconciliation row | a step row in the run inspector |
| `.rec` record number (pump id, shift id) | `r_01HV…` run id, `sr_…` step id |
| `.flag` variance flag (short / over / ok) | step status (failed / retried / succeeded) |
| `.read` readout, tabular mono | duration, bytes, status code, attempt count |
| posting / audit / **VOID** ceremony | enable, audit log, **destructive task delete** |
| "numbers are the loudest object" | durations and status codes are the loudest objects |
| MONO = counted record, SERIF = projection | MONO = what happened, SERIF = what is defined |

The rejected alternatives, briefly, so the choice is legible:

- **solon** (parliamentary order paper) — gravitas fits, but its native object is a *projection with
  a confidence band*. Klankish has no estimates; every number is counted. The serif/mono rule would
  invert into nonsense.
- **omoran-v2** (editorial broadsheet) — its differentiator is *a writer with citations*. Klankish
  has no analyst voice. The serif would be decoration.
- **leaksync** (e-ink quietude) — beautiful, but explicitly near-zero gravity ("the worst thing that
  happens is you unpair"). Klankish deletes production data and calls live APIs on a schedule. It
  needs a real critical red, which that system deliberately does not have.
- **ibeji** (cartographer's atlas) — native object is *territory*. Klankish has no spatial dimension.

---

## The law

Adapted from dipstick's ledger discipline, one sentence, checkable by opening any screen:

> **Every block is either DEFINITION or RECORD.**
>
> **Definition** is what you wrote: task names, descriptions, step config, schedules, notes.
> Source Serif 4 leads. Sentence case. Editable. It can change.
>
> **Record** is what happened: run ids, timestamps, durations, status codes, payloads, exit codes,
> log lines. IBM Plex Mono, tabular figures. Immutable. It cannot change.
>
> **A serif never states a measured value. A mono figure never states an intention.**

A screen holds both. A single block belongs to exactly one. This is what stops a dense operational
tool drifting into generic-dashboard mush across a hundred components.

**The one deliberate exception:** the big hero number on a task detail page (success rate, e.g.
`98.2%`) is a *computed aggregate*, not a counted record — it is set in mono anyway, because
rendering it in serif would imply it is an estimate. Noted here so it reads as a decision.

---

## Tokens

Light values are dipstick's, unchanged. Dark is **derived**, not invented, and holds these
invariants:

1. Hue and role are preserved; only luminance inverts. Emerald stays the single accent, oxblood
   stays the only red.
2. Dark is **warm near-black, never pure black** (`#14120F`, matching `--ink #1A1714`'s warmth). A
   warm-paper system that inverts to cold grey stops being the same system.
3. Contrast: body text ≥ 7:1, secondary ≥ 4.5:1 on its own background, in both themes.
4. No pure white in dark mode — brightest text is `#F2EDE2`, which is light mode's `--paper`. The
   themes are reflections of each other.

```css
:root {
  /* ---------- Paper & ink (LIGHT — dipstick, verbatim) ---------- */
  --paper:      #F2EDE2;   --paper-deep: #ECE5D4;
  --sheet:      #FBF7EC;   --sheet-2:    #F7F2E4;   --sheet-edge: #D6CDB8;
  --ink:        #1A1714;   --ink-2:      #3D3833;
  --ink-3:      #6E665B;   --ink-4:      #A39A8A;
  --hair:       #D6CDB8;   --hair-soft:  #E5DECC;   --rule: #1A1714;

  /* ---------- Emerald — the single accent ---------- */
  --emerald-50: #E7F4ED;  --emerald-100:#C7E4D2;  --emerald-200:#98CDAF;
  --emerald-400:#2D8A5C;  --emerald-600:#0E5C3A;  --emerald-700:#0A4A2E;
  --emerald-900:#06301E;

  /* ---------- States ---------- */
  --short: #9A1F18;  --short-bg: #F8E7E4;  --short-edge: #E6BFBC;  /* failed / destructive */
  --watch: #8E5A0E;  --watch-bg: #F8EED8;  --watch-edge: #E2CC95;  /* retried / degraded */
  --info:  #1F4D7A;  --info-bg:  #E8EEF4;  --info-edge:  #BFD0E1;  /* queued / system */
  --ok: var(--emerald-700); --ok-bg: var(--emerald-50); --ok-edge: var(--emerald-200);

  /* ---------- Step-kind marks (replaces dipstick's PMS/AGO/DPK) ----------
     Tiny inline marks on step rows. Never fills. */
  --k-http:      #1F4D7A;  /* ink-blue   — network */
  --k-shell:     #6B4E8E;  /* plum       — the machine */
  --k-branch:    #8E5A0E;  /* amber      — a decision */
  --k-transform: #0E5C3A;  /* emerald    — pure data */
  --k-email:     #A6522C;  /* terracotta — leaves the system */
  --k-storage:   #4A5D3A;  /* olive      — at rest */

  --serif: 'Source Serif 4', Georgia, serif;
  --sans:  'Inter', system-ui, sans-serif;
  --mono:  'IBM Plex Mono', ui-monospace, monospace;

  --r-sharp: 2px; --r-soft: 4px; --r-card: 3px; --r-pill: 9999px;
  --gutter: 24px;
}

/* DARK — derived. Applied only via explicit attribute; light is the default. */
:root[data-theme='dark'] {
  --paper:      #14120F;   --paper-deep: #0E0C0A;
  --sheet:      #1C1916;   --sheet-2:    #221E1A;   --sheet-edge: #322C26;
  --ink:        #F2EDE2;   --ink-2:      #D6CFC2;
  --ink-3:      #9A9184;   --ink-4:      #6B6459;
  --hair:       #322C26;   --hair-soft:  #262119;   --rule: #F2EDE2;

  /* Emerald re-tuned for a dark ground: the 600 that reads as "deep" on cream
     reads as "muddy" on near-black, so the usable accent shifts lighter. */
  --emerald-50: #0A2418;  --emerald-100:#0F3A26;  --emerald-200:#1C5C3C;
  --emerald-400:#3FA873;  --emerald-600:#4FBF86;  --emerald-700:#6FD3A0;
  --emerald-900:#C7E4D2;

  --short: #E8837A;  --short-bg: #2A1614;  --short-edge: #5C2A25;
  --watch: #D9A44E;  --watch-bg: #261C0D;  --watch-edge: #5A4420;
  --info:  #7AA8D4;  --info-bg:  #111E29;  --info-edge:  #2A4056;
  --ok: var(--emerald-600); --ok-bg: var(--emerald-50); --ok-edge: var(--emerald-200);

  --k-http: #7AA8D4;  --k-shell: #A88FC4;  --k-branch: #D9A44E;
  --k-transform: #4FBF86;  --k-email: #D4906B;  --k-storage: #9AAF83;
}
```

**Implementation note:** `prefers-color-scheme` is consulted **only** when no stored preference
exists. Light is the stated default, so a first-time visitor on a dark-mode OS still gets light.
The toggle writes `localStorage`, wrapped in try/catch (it throws in private browsing), and the
theme is applied by an inline script in `<head>` before first paint to prevent a flash.

---

## Type

| Role | Face | Size | Notes |
|---|---|---|---|
| Screen title | Source Serif 4 600 | 28px | `--track-display` |
| Section head | Source Serif 4 600 | 18px | |
| Task / step name | Source Serif 4 500 | 14–15px | definition |
| Body / chrome | Inter 400–500 | 13px | labels, buttons, nav |
| Overline | Inter 600 | 11px | `0.18em`, uppercase |
| **Every figure** | IBM Plex Mono 500 | 11–13px | `tnum`, `lnum` — durations, codes, counts |
| Record id | IBM Plex Mono 400 | 11px | `.rec`, `0.04em`, uppercase, `--ink-3` |
| Readout (hero) | IBM Plex Mono 500 | 28–56px | `.read`, `-0.02em` |
| Payload / logs | IBM Plex Mono 400 | 12px | `1.5` line-height |
| User note | Source Serif 4 italic | 13px | `.dictated` |

---

## The signature component: the step row

Dipstick's `.ledger` row, re-columned for a run. This is the object the whole product is built
around, so it is specified precisely.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● 01  fetch_users            HTTP    GET /api/users     200   412ms  ✓       │
│       sr_01HV8Q…                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● 02  has_pending            BRANCH  → notify_admin      —     2ms   ✓       │
│       sr_01HV8R…                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● 03  notify_admin           EMAIL   2 recipients       202   890ms  ✓       │
│       sr_01HV8S…                                                             │
└──────────────────────────────────────────────────────────────────────────────┘
  ↑     ↑                      ↑       ↑                  ↑     ↑      ↑
  kind  step key (serif)       kind    summary (mono)      code  dur    flag
  mark                         label                       mono  mono
```

```css
.step-row {
  display: grid;
  grid-template-columns: 18px 28px 1fr 84px minmax(160px,1.2fr) 52px 76px 24px;
  align-items: baseline;
  column-gap: 14px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--hair);
}
.step-row:first-child { border-top: 1px solid var(--ink); }
.step-row:hover       { background: var(--sheet); }
.step-row.is-open     { background: var(--sheet-2); }
.step-row .idx  { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.step-row .name { font-family: var(--serif); font-weight: 500; font-size: 14px; }
.step-row .sub  { font-family: var(--mono); font-size: 11px; color: var(--ink-3);
                  letter-spacing: 0.04em; }
.step-row .fig  { font-family: var(--mono); font-variant-numeric: tabular-nums;
                  font-size: 13px; text-align: right; }
```

Note the discipline in one row: the step **key** is serif (you named it — definition), everything
measured is mono (it happened — record). That single contrast is the system.

### Status vocabulary — one mapping, everywhere

| Status | Colour token | Flag | Dot |
|---|---|---|---|
| `queued` | `--info` | `QUEUED` | hollow |
| `running` | `--emerald-600` | `RUNNING` | **pulsing** (the only animation in the system) |
| `succeeded` | `--emerald-700` | `✓` | solid |
| `failed` | `--short` | `FAILED` | solid |
| `retried` | `--watch` | `RETRY n` | solid |
| `skipped` | `--ink-4` | `SKIPPED` | hollow |
| `cancelled` | `--ink-3` | `CANCELLED` | hollow |
| `timed_out` | `--short` | `TIMEOUT` | solid |

Dipstick's `.pulse` is inherited for `running` and is the **only** ambient loop in the product —
same restraint as ibeji's single breathing legend dot. If a second thing animates ambiently, one of
them is wrong.

---

## Motion

Inherited from dipstick: 120ms ease on colour/border transitions, nothing else. No slides, no
springs, no shimmer. Two additions, both earned:

- **Step row expand**: 140ms height+opacity. It is a drawer opening on a physical page.
- **New step row arriving via SSE**: a single 400ms background flash from `--emerald-50` to
  transparent. The row does not slide in — records are *inscribed*, not animated into place.

`@media (prefers-reduced-motion: reduce)` disables the pulse and the flash, and drops transitions to
0ms.

---

## The VOID ceremony

Dipstick's hazard-stripe `VOID` modal is inherited for exactly three irreversible actions:

1. Deleting a task **with run history** (the history dies with it)
2. Rotating the instance encryption key (all secrets must be re-entered)
3. Deleting a user with owned tasks (super_admin only)

The user types the literal word `DELETE` (or `ROTATE`). This is the only place a hazard stripe
appears. Pausing a task, revoking a key, cancelling a run — all reversible, all get an ordinary
confirm.

---

## Density

This is an operational tool read for minutes at a time, not a marketing page. Dipstick's density is
kept: 32px control height, 34px inputs, 11–13px type, hairlines instead of shadows, 24px gutter.

The only shadow in the system is on overlays that genuinely float (command palette, modal) —
matching dipstick, where the popup casts a shadow because it physically floats.

---

## Accessibility

- Focus: `box-shadow: 0 0 0 3px rgba(14,92,58,0.28)` light / `rgba(79,191,134,0.32)` dark. Never
  `outline: none` without a replacement.
- Status is never colour alone — every state carries a text flag or glyph. A red dot and a green dot
  are identical to a deuteranopic reader; `FAILED` and `✓` are not.
- Tables: real `<table>` with `<caption>`, `scope` on headers. The step list is a table, because it
  is one.
- Live regions: run status updates announce via `aria-live="polite"`.
- Every icon-only button has an `aria-label`.
- Contrast verified in both themes, not assumed.
