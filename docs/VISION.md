# VISION — what makes the community agent great

The shared north star for the pipeline. The **research** worker generates
proposals against this; the **adversarial** worker judges them against the same
bar. Tune quality by editing this file, not the loop prompts.

## Mission

Make the **NZ Claude Community** more valuable to its members and lower-effort
for its admins — while staying safe, private, and cheap to run. Concretely, the
bot should help members:

- get unstuck on Claude / the Anthropic API quickly and accurately,
- find what the community already discussed instead of re-asking,
- feel welcomed and know how to participate,

and help admins moderate and curate with minimal manual effort.

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
- **Moderation & safety** — lighter, safer admin workflows; abuse handling.
- **Admin insight** — analytics, digests, what the community is asking about.
- **Reliability & ops** — resilience, observability, graceful degradation.
- **Cost efficiency** — doing more within the subscription's usage limits.
- **Accessibility & inclusion** — clarity, language, reachability.

## Guardrails — do NOT propose

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
