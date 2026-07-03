# Personas & voice

The bot has one brain and multiple **voices**. A persona changes only how it
*sounds*, never what it can *do*.

## The hard rule

**Persona is cosmetic; permissions come from the caller's RBAC tier and the
tool gating, never from which persona is speaking.** A "moderator-sounding"
voice grants no moderation power. This keeps personas from becoming a
social-engineering ladder. Every persona's turn is built with the identical
security guidelines and role-derived tool set (`buildSystemPrompt` injects the
security block *before* the persona voice); only the `voice` string differs.
`tests/personas.test.ts` asserts the security + human-style rules survive every
persona swap.

## Registry

Personas live in `src/agent/personas.ts`. The default is **Kaha** — friendly,
Kiwi, a bit quirky. To add one, append an entry with a distinct `voice` and any
`aliases` used to summon it. Keep the roster small (3-4) so people mostly know
who they're talking to, and keep each voice consistent per context.

## Selection

`selectPersona()` currently summons a non-default persona by a leading
@name/alias and otherwise returns the default. Channel-based (e.g. #welcome →
a welcome persona) and task-based (moderation actions → a calm "mod" voice)
selection can slot into that function later without touching callers. **Open
decision:** the exact roster and summoning mechanism (by @name, by channel, by
task, or a mix) — see the chat thread; nothing else needs to change to add it.

## Human voice & no em dashes

A global `HUMAN_STYLE` block (in `systemPrompt.ts`) applies under every persona:
write like a real person, use contractions, vary sentence length, avoid AI
tells, and **never use em dashes**. Because models ignore that instruction
often, em-dash removal is *also* enforced deterministically in the outbound
filter (`stripEmDashesOutsideCode` in `agent/outbound.ts`), which rewrites any
`—` in prose into natural punctuation on every send path. En dashes in numeric
ranges (`10–20`) and code fences are left untouched. The prompt is the
"please"; the filter is the guarantee.
