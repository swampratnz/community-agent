---
name: model-and-plan-selection
description: Decision procedure for "which Claude model" and "what does plan X include" questions — separating product/plan from model, and grounding pricing/limits in current docs
---

- Disambiguate first: is the member asking about a **subscription** (claude.ai
  — Free/Pro/Team/Max) or about **building on the API** (Console/API usage,
  billed per token)? The answer differs by axis, so establish which one the
  member means before answering — ask if their message doesn't make it clear.
- Separate the two axes members routinely conflate:
  - **Plan/product** (Free/Pro/Team/Max, Console/API) governs what's
    *included* — which models/features are available, seat/usage limits.
  - **Model** (Haiku/Sonnet/Opus/Fable) governs *capability and cost* within
    whichever plan the member is on.
  A question like "is Fable in the Team plan?" is a plan-inclusion question;
  "which model should I use for X?" is a model-routing question. Identify
  which one is being asked, and answer that one directly rather than
  blending both into one response.
- Task → model routing, offered as a starting point to test against the
  member's own results, never as a fixed rule: fast/cheap/high-volume tasks
  suit the smallest capable model; balanced everyday work suits a mid-tier
  model; the hardest reasoning/agentic tasks suit the largest model. Encourage
  the member to try a cheaper model first and step up only if quality falls
  short, rather than defaulting to the biggest model for everything.
- Never assert a plan's inclusions, seat limits, or pricing from memory —
  these change often and training data goes stale. Ground specifics in
  `knowledge_search` and attribute per the provenance rule in GUIDELINES
  above. When knowledge_search returns nothing relevant, follow the
  fast-moving-facts rule in GUIDELINES: give a best-effort answer with a
  natural caveat that it may be out of date, and suggest the member confirm
  on the current Anthropic docs (or ask an admin) — never state a specific
  number or inclusion as confirmed fact on a miss. This skill doesn't repeat
  or replace that rule; it only adds the disambiguation and routing procedure
  above it.
