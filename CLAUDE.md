# CLAUDE.md — conventions for this repo

Guidance for any Claude Code session working in `swampratnz/community-agent`.

## What this is

A TypeScript/Node service (the "NZ Claude Community" agent) that bridges a
Discord server and a WhatsApp number to a Claude Agent SDK agent with
persistent Postgres + pgvector memory and a gated three-tier RBAC model. Start
with `README.md`, then `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## Build / test / verify

- `npm run typecheck` — must be clean.
- `npm test` — Node test runner via tsx; must pass. Security invariants live
  here (tool gating, confirm flow, secret redaction, WhatsApp wire helpers) —
  when you touch those areas, extend the tests.
- `npm run build` — tsc + copies `schema.sql` into `dist/`.
- DB-touching changes: exercise against a local Postgres 16 + pgvector.
- Run all three (typecheck, test, build) green before opening/updating a PR.

## Security posture (do not regress)

This bot processes untrusted public chat. Preserve these invariants:

- Built-in Claude Code tools are disabled per turn (`tools: []`); only admin+
  turns additionally get `WebSearch`. `WebFetch` is disallowed for everyone.
- Roles come from env (super admins) + the `community_users` table — **never**
  from message content. Tool surface is tier-derived; privileged tools also
  re-assert the tier.
- Destructive actions are CONFIRM-gated and executed by the router, not the
  model. Outbound filtering (secret redaction + code policy) lives in the
  adapters' send paths.
- Admin data access is scoped in SQL to conversations the admin is in.

## Multi-loop pipeline

This repo is developed by a supervised multi-session pipeline — see
`docs/PIPELINE.md`. If you are running as one of those loops, obey the
ownership rules:

- **Only the build loop** writes code or opens PRs. PR-review comments only;
  research & adversarial touch issues only.
- **No loop merges PRs** — a human merges.
- WIP caps: ≤3 open `status:draft`, exactly ≤1 `status:building`.
- Coordinate only through issue labels; when blocked or ambiguous, add
  `needs-human` and stop rather than guess.
- Everything traces to an issue number; the build session works in its own git
  worktree.

## Conventions

- Match existing style; keep comments at the density of surrounding code.
- Never commit secrets. `.env` is git-ignored; `whatsapp-auth/` and `src/auth/`
  are distinct — the latter is source and must stay tracked.
- Do not put model identifiers in commits, PR bodies, or code.
