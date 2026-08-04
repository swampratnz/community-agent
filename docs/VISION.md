# VISION — what makes the community agent great

The shared north star for the pipeline. The **research** worker generates
proposals against this; the **adversarial** worker judges them against the same
bar. Tune quality by editing this file, not the loop prompts.

## Where this repo ends

This repo is a **module on a framework**, not the whole agent. The framework is
[`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base), consumed
as an npm package; this repo is `src/module/` plus the composition root, and
`src/module/agentModule.ts` is the manifest that registers everything it
contributes.

That boundary decides what is proposable here, because **the build worker can
only edit this repo**. A proposal needing a base change cannot be built no
matter how good it is — it has to land in agent-base first and arrive as a
version bump.

Roughly:

- **This repo** — tools and their tiers, community prompt sections and persona,
  notice/string packs (including te reo), skills, module schema fragments,
  community jobs and digests, moderation *policy*, ingest sources and topics.
- **agent-base** — the turn engine and prompt spine, the router's security
  sequence, CONFIRM and outbound filtering, RBAC mechanism, platform adapters,
  storage/migration machinery, the job runner, retention and budgets, health,
  and the config schema itself (so **a new env var is an agent-base change**).

Two consequences worth internalising before proposing:

- Some theme areas below are now mostly base-owned — **Reliability & ops** and
  **Cost efficiency** especially, and parts of **Accessibility & inclusion**
  (base selects the language/style axis; this repo supplies the strings). Prefer
  the module-side half of those themes, or pick another theme.
- "Make the bot do X" is usually module work. "Make the *framework* do X" is
  not proposable here, however desirable.

## Mission

Make the **NZ Claude Community** more valuable to its members and lower-effort
for its admins — while staying safe, private, and cheap to run. Concretely, the
bot should help members:

- get unstuck on Claude / the Anthropic API quickly and accurately,
- find what the community already discussed instead of re-asking,
- feel welcomed and know how to participate,
- grow their Claude/API skills and connect with other NZ builders working on
  similar things,

and help admins moderate and curate with minimal manual effort.

The bot is a *community* agent, not just an answer service: the best features
create member→member and member→community value (members learning from,
finding, and contributing to each other), not only bot→member value.

## Who we serve

- **Members** — NZ people building with Claude/the API. Primary audience.
- **Admins** — trusted members who moderate and curate, scoped to their own
  conversations. Value = leverage: do more with less manual work.
- **Super admin** — the operator. Value = control, safety, and visibility.

## What a great proposal does

Score each idea on:

1. **Member/admin impact** — does it solve a real, felt problem, or is it a
   nice-to-have nobody asked for?
2. **Reach** — how many people benefit, how often?
3. **Effort** — shippable in roughly one PR (with tests) beats a big project.
4. **Fit** — respects the architecture and the security posture (see below).
   A feature that fights the design is a bad feature even if useful.
5. **Measurable** — we can state how we'd know it worked.

Prefer **high-impact, high-reach, low-effort, low-risk**. When unsure, propose
the **smallest viable version** and note how it could grow.

## North-star metrics

"Measurable" needs an anchor. These are the community-level signals success
looks like, all derivable from data the bot already stores (no new tracking
is implied — and per the guardrails below, none should be proposed that
expands member-data collection):

- **Answer quality** — `rate_answer` helpful-rate trending up; thumbs-down
  themes shrinking in the digests. Both halves now instrumented in the
  weekly admin digest (see `docs/ARCHITECTURE.md`'s digest-signals section):
  the helpful-rate line (issue #653) and the recurring-unhelpful-theme count
  (issue #724, `list_unhelpful_themes`).
- **Knowledge leverage** — knowledge-shortcut hit rate up; repeat-question
  clusters (context digests) shrinking; time-to-first-answer in auto-answer
  channels down.
- **Participation** — weekly distinct askers up; and once flywheel features
  exist, member contributions (accepted candidate entries, showcased
  projects) becoming a routine occurrence rather than zero.
- **Admin leverage** — moderation/curation actions per admin holding steady
  or falling while the member base grows.

A strong proposal names the metric it moves and how we'd read the change;
"nice but unmeasurable" is a rubric fail, not a footnote.

## Ground proposals in evidence

Propose from observed need, not imagination. Signal sources (in rough order):

1. `community-feedback` issues (real member/admin requests).
2. Open and closed `proposal` issues — build on what's wanted, avoid what was
   rejected (read *why* it was rejected).
3. Recent commits + the docs — know what already exists so you extend, not
   duplicate.
4. `needs-human` items and gaps called out in ARCHITECTURE.md / SECURITY.md
   (e.g. documented deferrals and residual risks).
5. Web search for what comparable developer communities value.

## Theme areas (rotate for diversity)

Each research run is memoryless, so deliberately vary across:

- **Onboarding & welcome** — first-run experience, help, discoverability.
- **Knowledge quality & recall** — better curation, search, freshness, sourcing.
- **Answer quality** — accuracy, citations, NZ context, handling "I don't know".
- **Member growth & connection** — helping members get *better* at building
  with Claude (docs-grounded feedback on their prompts/tool schemas, "where do
  I start with X" paths) and helping them find each other (opt-in,
  self-declared interests/projects; never inferred from message content).
- **Community flywheel** — members contributing durable value back: member-
  suggested knowledge entries flowing through the existing admin-reviewed
  candidate queue, project showcases, member-facing digests of what the
  community discussed. Contributions are always admin-gated before they can
  influence answers.
- **Moderation & safety** — lighter, safer admin workflows; abuse handling.
- **Admin insight** — analytics, digests, what the community is asking about.
- **Reliability & ops** — resilience, observability, graceful degradation.
  *Mostly agent-base-owned; only the module-side half is proposable here.*
- **Cost efficiency** — doing more within the subscription's usage limits.
  *The turn engine and shortcuts are agent-base; module-side levers are job
  cadence, digest scope and prompt-section size.*
- **Accessibility & inclusion** — clarity, language, reachability.

## Guardrails — do NOT propose

- **Anything requiring an `@swampratnz/agent-base` change** — a new or changed
  env var, or behaviour owned by the turn engine, router security sequence,
  CONFIRM/outbound filtering, adapters, storage/migration machinery, the job
  runner, retention/budgets or health. The build worker cannot edit the
  framework, so such a proposal is unbuildable here however strong it is; it
  belongs in the agent-base repo. See "Where this repo ends" above. If the
  module-side half is independently valuable, propose only that half.
- **Rewrites** or sweeping refactors; anything not shippable in ~one PR.
- Features that **expand the attack surface** (new privileged tools, broader
  data access, new untrusted inputs) without a clear, proportionate payoff.
- Anything that **weakens the security posture** in SECURITY.md (tier-derived
  tools, CONFIRM gating, secret redaction, conversation-scoped admin access,
  identity-from-platform-only).
- **WhatsApp features that increase ToS/ban risk** on the Baileys path.
- **Privacy regressions** — more retention or exposure of member data without a
  strong, documented reason (NZ Privacy Act 2020 expectations apply).
- Features that **blow the shared Max usage pool** (heavy per-message model
  calls, chatty background work) without a cost story.
- **Duplicates** of shipped work or existing proposals; vague "improve X".

A skipped run is better than a weak proposal. Quality over volume.
