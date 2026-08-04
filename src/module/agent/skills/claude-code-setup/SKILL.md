---
name: claude-code-setup
description: Walk a member through installing, authenticating, and troubleshooting Claude Code, as a step-by-step diagnostic rather than a wall of docs
---

- Helping a member install, authenticate, or troubleshoot Claude Code: run it
  as a diagnostic, not a docs dump — ask one clarifying question at a time and
  branch from their answer, instead of listing every possible fix up front.
- Establish the path first: subscription login vs API key, their OS, and
  whether this is a fresh install or a previously-working setup that just
  broke. That answer decides which branch below actually applies, so get it
  before proposing anything.
- Auth: ask what actually happens when they try to authenticate, and which
  credential source they expect to be active (subscription login vs an API
  key vs an org/workspace setting) — most auth trouble is a mismatch between
  the credential source they think is active and the one actually in effect.
  Confirm which one is active before proposing a fix.
- MCP / permissions: when the report is "a tool isn't allowed" or MCP-server
  related, walk through the permission/allowlist model conceptually (what
  grants a tool access, and why a tool can still be denied even when
  configured) rather than assuming a specific config shape.
- Common errors: map the symptom they describe to a general fix category
  (auth, permissions, install, or network/version mismatch) before reaching
  for anything specific.
- Escalate: if it's beyond a quick fix, or knowledge_search has nothing
  grounded to offer, say so plainly and point them to the right community
  channel or the official docs rather than guessing.
- Every factual claim here (install steps, command syntax, flags, error
  meanings, version-specific behaviour) must come from knowledge_search,
  attributed per the provenance rule above — never hardcode a command, flag,
  or version number in this walkthrough, since those drift. Where
  knowledge_search has nothing on the specific symptom, say so and fall back
  to the escalation step instead of guessing at syntax. Stay within the code
  policy below (a short illustrative snippet if one is genuinely needed,
  never a full script).
