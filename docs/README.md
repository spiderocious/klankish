# Klankish — Documentation

A self-hostable task automation engine. Define a task as a graph of steps (call an API, run a
command, branch on the response, email someone, write a file), attach a schedule, and the engine
runs it and records everything.

**Read in this order:**

| Doc | What it holds |
|---|---|
| [goals.md](./goals.md) | What this is, the one-sentence goal and why, non-goals, roles, definition of done |
| [tech-spec.md](./tech-spec.md) | Stack + reasoning, data model, the queue, the engine, errors, auth, deployment, risks |
| [design-guide.md](./design-guide.md) | Design system choice and why, tokens (light + derived dark), the law, the step row |
| [features.md](./features.md) | Full feature inventory, tiered P1 / P2 / later |
| [ideas.md](./ideas.md) | Ideas kept and rejected, open questions, "things that look wrong but aren't" |
| [todo.md](./todo.md) | Build order, phase by phase |

**The short version:** the differentiator is the *run record*, not the scheduler. Cron already
fires things on time; what people lack is the ability to find out what happened when it did. So
every step persists its resolved input, output, timing and error before the next one starts, and the
run inspector is a first-class screen built early — because it is how every later phase gets
debugged.

**Stack:** Node 22 + TypeScript strict · Fastify 5 · Postgres 16 (queue included, via
`FOR UPDATE SKIP LOCKED`) · React 19 + Vite + TanStack Query · Resend · S3/R2 · Docker.

**Design:** the `dipstick` ledger-broadsheet stance, because a ledger is literally what this product
keeps. Light by default, dark derived from the same tokens.
