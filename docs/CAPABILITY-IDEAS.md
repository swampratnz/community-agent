# CAPABILITY IDEAS — candidate directions for expanding what the bot can do

A human-curated backlog of *capability-level* ideas, written after a review of
the current tool surface (`src/auth/rbac.ts`), the schema, the background jobs,
and the shipped/rejected issue history. It is deliberately a different altitude
from the research worker's output: that loop is very good at finding the next
small increment on an existing mechanism, and most of what follows is a **new
axis** rather than an increment.

Nothing here is approved or committed. Each entry is written so it can be
turned into a `proposal` issue against the [VISION.md](VISION.md) rubric — or
discarded — without further archaeology. Effort is "roughly one PR with tests"
unless stated.

**This file mixes shipped and unbuilt ideas.** Ideas get written up here
before they're built, and the file is not pruned when one ships — so an entry
below may describe something that already exists on `main`. The **`Status:`**
line directly under each heading is authoritative; the surrounding prose is
the original write-up and is not kept in sync with what actually shipped.
Check `Status:` before treating an idea as an open opportunity — this
includes the research worker, which reads this file to generate proposals.

Grouped by axis, roughly highest-value first within each group.

---

## A. New senses — things the bot currently cannot perceive

The single biggest structural gap. `IncomingMessage` (`src/platforms/types.ts`)
carries `text: string` and nothing else; the Discord adapter builds it from
`message.content` alone (`adapter.ts:390`/`:406`) and drops attachments on the
floor. An image-only message arrives as empty text.

### A1. Screenshot / image input *(high impact, medium effort)*

**Status:** Shipped (issue #783). `IMAGE_INPUT_ENABLED` (off by default,
`IMAGE_INPUT_MIN_ROLE` default `'super_admin'` — a deliberate correction of
this entry's own `member+` draft text, see SECURITY.md §22) gates a single
Discord image attachment per message, MIME-allowlisted and byte-capped, passed
to `query()` as an image content block alongside the turn's text. No image
bytes are stored. `src/media/grokImage.ts` remains unrelated: it generates
images as tool *output*, not image input/perception.

**Why:** in a builders' community the most common support artifact is a
screenshot — a stack trace, a console error, a Workbench screenshot, a billing
page. Today the bot is blind to all of it and answers the caption instead, or
nothing. This is the one gap where the bot visibly can't do what a human helper
in the same channel does trivially.

**Smallest version:** Discord only, member+, flag-gated
(`IMAGE_INPUT_ENABLED`, off by default). Accept at most one image attachment
per message, bounded by bytes and MIME allowlist (`image/png|jpeg|webp`), and
pass it to `query()` as an image content block alongside the existing text.
No storage of image bytes — the interaction row keeps text only, exactly as
today, so retention/`forget_me` semantics are unchanged.

**Risks to design against:** an image is *untrusted input* in the same sense a
message is, and text rendered inside an image is a live prompt-injection
channel that no outbound filter sees on the way in. The existing
untrusted-content framing in `systemPrompt.ts` needs an explicit clause for
image-borne instructions (the prompt-review clause for pasted prompts, issue
#635, is the precedent). Cost is the other constraint: images are materially
more expensive per turn than text, so a per-user daily cap alongside
`DAILY_REPLY_LIMIT_PER_USER` is part of v1, not a growth path.

**Grows into:** WhatsApp images (same normalisation), and admin-side triage of
reported image content.

### A2. Discord voice-message transcription *(medium impact, low effort)*

**Status:** Shipped (#735). `DISCORD_VOICE_ENABLED` (`src/config.ts`, off by
default), wired into `src/platforms/discord/adapter.ts` via
`transcribeVoiceNote`, matches the smallest-version spec: Discord-prefixed
caps (`DISCORD_VOICE_MAX_SECONDS`, `DISCORD_VOICE_MIN_ROLE`,
`DISCORD_VOICE_RATE_LIMIT_PER_HOUR`) shaped like the WhatsApp knobs, and it
reuses `voiceLanguageCaveatNotice.ts` unchanged.

**Why:** the machinery already exists and is used on exactly one platform.
`src/media/voiceTranscribe.ts` + the `WHATSAPP_VOICE_*` knobs transcribe
WhatsApp voice notes locally via transformers.js. A Discord voice message is
just an audio attachment on a normal message, so the same local pipeline —
same model, same cap, same rate limit, same min-role — applies with no new
dependency, no new network call, and no new cost centre (transcription is
local CPU, not a Max-pool draw).

**Smallest version:** `DISCORD_VOICE_ENABLED`, reusing
`WHATSAPP_VOICE_MAX_SECONDS`-shaped caps under Discord-prefixed names, gated
on the same min-role. The existing voice-language caveat notice
(`voiceLanguageCaveatNotice.ts`) applies unchanged.

**Note:** this is a symmetry fix more than a new capability, which is exactly
why it is cheap.

---

## B. Agent SDK capabilities the deployment doesn't use yet

`buildQueryOptions` (`src/agent/core.ts`) sets `tools: []`, `settingSources:
[]`, and a tier-derived `allowedTools`. That is the right security posture, and
it also means several SDK features are simply switched off. Three of them are
worth switching on deliberately.

### B1. Agent Skills — procedural playbooks, separate from the KB *(high impact, medium effort)*

**Status:** Shipped (#741/#742). `AGENT_SKILLS_ENABLED` (off by default),
`src/agent/skills/` holds repo-bundled skill directories
(`prompt-review`, `agent-architecture-review`, `claude-code-setup`,
`project-showcase`, `model-and-plan-selection`), and `src/agent/core.ts`
wires `plugins`/`skills` exactly as designed (repo path only, no
`settingSources` change). `prompt-review` is the `#635` checklist migration
this idea specifically proposed.

**Why:** the knowledge base answers *"what is true"* (retrieved facts with
citations and freshness). Nothing in the system answers *"how do I carry out
this multi-step task"* except the ever-growing `GUIDELINES` block in
`systemPrompt.ts`, which is paid for on **every single turn** whether relevant
or not. Skills are progressive disclosure: metadata is cheap and always
present, the body loads only when the model chooses the skill.

**How it fits the security posture:** skills are filesystem artifacts
discovered via `settingSources` — which this repo deliberately sets to `[]`.
The SDK's `plugins` option loads skills from an explicit path instead, so a
repo-bundled `skills/` directory can be enabled **without** opening `user`/
`project` settings. Pair it with the `skills` allowlist option (names only) so
the set is enumerated in code, and add `Skill` to `allowedTools` only for the
tiers that should have it. Note the SDK ignores a skill's `allowed-tools`
frontmatter, so tool gating stays exactly where it is today.

**Hard boundary:** a skill is instruction-shaped, not data. Skills ship **in
the repo, reviewed like code** — never member-authored, never admin-authored
at runtime. That line is what keeps this from becoming a privilege-escalation
surface, and it is the reason `suggest_knowledge`'s candidate-queue model does
*not* transfer here.

**Candidate first skills:**
- `debug-claude-api-error` — a decision tree from error code / symptom to
  likely cause to fix, grounded in the ingested docs.
- `getting-started-path` — structured "where do I start with X" routes
  (Agent SDK, MCP, prompt caching, batch), a VISION theme area with nothing
  built against it.
- `prompt-review` — lift the #635 checklist *out* of the always-on system
  prompt into a skill, which is a cache-prefix reduction on every turn as
  well as a capability.

**Measurable:** cached-prefix token count per turn (should fall), and
skill-invocation counts vs. `rate_answer` helpful-rate on those threads.

### B2. Structured output for the classifiers *(medium impact, low effort, security-relevant)*

**Status:** Shipped for all three targets — the abuse classifier (#720), the
knowledge refresh researcher (#835), and the context builder's cluster
summariser (#831). `classifyAbuseWithLlm` in `src/moderation/moderator.ts`,
`researchTopic` in `src/context/knowledgeRefresh.ts`, and `summarizeCluster`
in `src/context/builder.ts` all now set
`outputFormat: { type: 'json_schema', schema: ... }` and read
`structured_output` via a narrow-or-throw parser instead of regex-matching
free text — covered by `tests/abuseClassifierStructuredOutput.test.ts`,
`tests/knowledgeRefreshStructuredOutput.test.ts` and
`tests/contextBuilderStructuredOutput.test.ts` respectively. Every call
site's boundary shape (`Detection | null`, `string | null`, and
`ClusterSummarizer`'s `{ topic, summary, candidate }`) is unchanged, so no
caller needed touching.

**Why:** `classifyAbuseWithLlm` (`src/moderation/moderator.ts:402`) asks for
`"CLEAN"` or `"ABUSE: <reason>"` as free text and then regex-parses it
(`/^\s*ABUSE:\s*(.+)$/im`). Anything the model emits that doesn't match — a
refusal, a preamble, a reformat — silently becomes *clean*, which fails open on
the safety-relevant path. The SDK's `outputFormat: { type: 'json_schema' }`
makes the shape a contract instead of a hope, and lets the verdict carry a
confidence field so the strike threshold can be tuned instead of being
implicitly "the regex matched".

**Smallest version:** schema-constrain the abuse classifier only, keep the
existing `Detection | null` return shape at the boundary so nothing downstream
changes, and keep the throw-on-failure discipline that lets `makeClassifier`'s
cache distinguish "model said clean" from "call failed".

**Grows into:** nothing further in this group — with #831 the last
free-text-parsed model boundary here is gone. Any NEW model call should adopt
the same `outputFormat` + narrow-or-throw discipline from the start.

### B3. `fallbackModel` for graceful degradation *(low effort)*

**Status:** Shipped (#738). `AGENT_MODEL_FALLBACK` (`src/config.ts`) is wired
into `buildQueryOptions`'s `fallbackModel` option in `src/agent/core.ts`,
applied uniformly across roles as proposed; unset is byte-identical to
before. The config comment cites this section by name.

**Why:** the repo already has an upstream-failure path (`upstreamFailure.ts`,
`pauseNotice.ts`, `UPSTREAM_LIMIT_ALERT_ENABLED`) whose best outcome is a
polite failure. `fallbackModel` turns a class of those into a degraded answer
instead of no answer. Slots naturally beside the existing per-tier `model` /
`memberModel` / `classifierModel` tiering.

---

## C. Cost and latency — a deterministic surface beside the model

### C1. Discord slash commands *(high impact, medium effort)*

**Status:** Shipped (#744). `DISCORD_SLASH_COMMANDS_ENABLED` (off by default),
`src/platforms/discord/slashCommands.ts` implements the exact four
read-only commands proposed — `/kb`, `/whois`, `/projects`, `/guidelines` —
resolving role the same way chat messages do and calling the same
repository/render functions the chat-path tools use.

**Why:** every interaction today is a message that costs a model turn. The repo
already recognises this — `ACK_SHORTCUT_ENABLED`, `KNOWLEDGE_SHORTCUT_ENABLED`,
`REPEAT_MAX_TURNS_SHORTCUT_ENABLED` and the `shortcut_hits` table exist purely
to short-circuit the agent for cases where a deterministic answer is as good.
Slash commands generalise that: a registered application command calls the
**same repository function the tool handler calls**, with zero model calls, an
ephemeral reply (no channel noise), and — importantly — *discoverability*.
Right now a member has to guess that `who_is_into` or `list_projects` exists;
Discord's command picker lists them.

**Smallest version:** four read-only, self-scoped commands with obvious
deterministic semantics — `/kb <query>` (`knowledge_search`), `/projects`,
`/whois <topic>` (`who_is_into`), `/guidelines`. RBAC is resolved the same way
the router already resolves it (platform identity → DB), never from the
interaction payload; open-mode guests get the same surface members get today.

**Measurable:** share of interactions served with no model call; median
time-to-answer on those.

**Watch out for:** command registration is a new outward Discord write at
startup — guild-scoped, not global, and it needs the same "validate targets"
discipline as `announce`. It's also Discord-only by nature, so it must not
become the *only* path to any capability (WhatsApp parity), which argues for
read-only shortcuts rather than privileged actions.

### C2. A "what needs me today" admin roll-up *(medium impact, low effort)*

**Status:** Shipped (#745). `review_queue` (`src/agent/tools.ts`, admin-only
via `src/auth/rbac.ts`) composes all five queues into one read-only,
argument-less call, with oldest-item age for access requests, suggestions,
and reports; knowledge candidates and appeals show count only, a named gap
the tool's own description states rather than hides.

**Why:** there are now five separate admin review queues —
`list_knowledge_candidates`, `list_suggestions`, `list_reports`,
`list_appeals`, `list_access_requests` — each pulled one at a time in chat, and
each costing its own turn. `admin_digest` (#499) proved the shape: one pull,
existing scoping, no new data. A single `review_queue` returning counts +
oldest-item age per queue turns five turns into one and makes "nothing is
rotting" checkable at a glance.

**Effort is genuinely low:** pure aggregation over reads that already exist
with their scoping already correct. No new table, no new tier, no new data
exposure.

---

## D. Member→member value — the VISION's own stated weak spot

VISION.md says plainly that the best features create member→member value, and
that member contributions "becoming a routine occurrence rather than zero" is a
north-star metric. `set_my_interests`/`who_is_into` (#634) and
`share_project`/`list_projects` (#646) just built the substrate. These are the
next rungs.

### D1. Opt-in "can someone help with X" handoff *(high impact, medium effort)*

**Status:** Shipped (#729). `set_helper_availability` and `find_helper`
(`src/agent/tools.ts`, `src/storage/repository.ts`, RBAC entries in
`src/auth/rbac.ts`) implement the opt-in flag, per-helper rate cap, and
matching restricted to self-declared interests, as proposed.

**Why:** `who_is_into` returns a *list* — the member still has to cold-DM a
stranger, which most people won't. The gap between "here are five people
interested in MCP" and an actual conversation is where the flywheel currently
stalls.

**Smallest version:** a self-scoped, explicitly opt-in availability flag
(`set_my_interests`-shaped — one row, instantly reversible) plus a
`find_helper(topic)` that notifies **at most one** opted-in member per request,
rate-capped per helper per week so a popular member can't be farmed. Only
self-declared interests are ever matched, never anything inferred from message
content — the #634 line, unchanged.

**Risk:** this is the one idea here that generates unsolicited pings. The
opt-in flag, the per-helper cap, and a one-word way to opt back out are not
polish, they are the feature.

### D2. Close the answered-question → knowledge-base loop *(medium impact, low effort)*

**Status:** Shipped (#726). `KNOWLEDGE_ANSWER_CANDIDATE_ENABLED` (off by
default, `src/config.ts`) drafts a candidate from the `rate_answer` handler
in `src/agent/tools.ts` when a rating is `helpful: true` on an ungrounded
answer, reusing `suggest_knowledge`'s (#633) dedup+write path exactly as
proposed. Excludes 1:1 DMs from the guild-wide candidate queue (a #730
review addition beyond the original write-up).

**Why:** the flywheel is built at both ends and open in the middle.
`knowledge_gaps` captures what the KB *couldn't* answer, and
`knowledge_candidates` accepts drafts from the offline builder and (since #633)
from members. But an exchange the bot answered *well* — thumbs-up on
`answer_feedback`, on a topic with no existing entry — evaporates. That is the
cheapest possible source of good KB entries and it's on the floor.

**Smallest version:** when a `rate_answer(helpful: true)` lands on a turn whose
`knowledge_search` returned nothing above the floor, draft one candidate into
the existing queue, reusing the builder's existing dedup guard verbatim.
Admin-gated before it can influence answers, exactly like every other candidate
path. Rate-capped, off by default.

### D3. Learning paths / "start here" routes *(medium impact, low effort as content)*

**Status:** Not started. No skill or KB-entry-kind implements sequenced
"where do I start with X" routes; no reference to a learning-path concept
exists anywhere in `src/`.

**Why:** a named VISION theme ("where do I start with X") with nothing built
against it. The KB answers narrow questions well and sequenced ones not at all.

**Two possible shapes**, worth deciding before proposing: a new *kind* of KB
entry (ordered, multi-step, cited) versus a skill (B1). The skill shape is
probably right — a path is procedural, and it avoids adding a second entry kind
to a retrieval system that is currently uniform.

---

## E. Freshness — the community's actual daily question

### E1. Anthropic release / deprecation watcher *(high impact, medium effort)*

**Status:** Shipped (#739). `RELEASE_WATCH_ENABLED` (`src/config.ts`, off by
default) diffs a fixed official source and lands new items as KB entries
with `auto` provenance, rolling up into `MEMBER_DIGEST_ENABLED` rather than
a new posting path, as proposed.

**Why:** `docsIngest.ts` ingests reference docs from `llms.txt` weekly, and
`check_status` reports live incidents. Neither covers **announcements**: new
models, deprecations and sunset dates, pricing changes, feature GAs. For a
community whose entire subject matter is one fast-moving product, "what changed
this week" is plausibly the single highest-value recurring post, and it is
public data — no privacy cost, no member-data expansion, no new untrusted input
beyond a fixed official URL the ingest path already knows how to treat.

**Deprecations deserve special mention:** a member still building against a
model with an announced sunset date is a concrete, expensive problem the bot is
uniquely positioned to catch.

**Smallest version:** one fixed official source, the same single-source
discipline `docsIngest` already enforces, diffed on content like the existing
weekly refresh; new items land as KB entries with `auto` provenance (already a
modelled provenance value) and roll up into the existing
`MEMBER_DIGEST_ENABLED` post rather than inventing a new channel-posting path —
which also sidesteps the unresolved auto-post policy question that closed #636.

---

## F. Measurement — knowing whether any of this worked

### F1. Extend the golden eval from retrieval to answers *(medium impact, medium effort)*

**Status:** Shipped (#779). `npm run eval:answers` (`scripts/eval-answers.ts`)
runs a curated fixture (`tests/fixtures/answersEval.json`) against the real
`runAgentTurn` pipeline and grades each reply deterministically via
`mustContain`/`mustNotContain` fact fragments.

**Why:** `tests/knowledgeEval.test.ts` measures precision@K of *retrieval*
against a curated query set, which is genuinely good and stops well short of
the thing members actually experience — the answer. There is currently no way
to tell whether a system-prompt edit (a skill, a new guideline, a persona
change) improved or degraded answers, other than watching `rate_answer` drift
weeks later.

**How it fits the posture:** this must follow the RED-TEAM.md precedent —
**maintainer-run, off CI, on the maintainer's own credential**. Grading answers
means real model calls plus a judge call; RED-TEAM.md already worked through
exactly why that cannot live in CI (shared Max pool per PR, non-deterministic
pass/fail feeding the retry loops flaky failures, and the credential boundary).
A `npm run eval:answers` harness with a small golden Q&A set, run before a
prompt change ships, is the right shape.

---

## Quick triage

| Idea | Impact | Effort | Status | Notes |
|---|---|---|---|---|
| A1 Image input | High | Medium | Not started | Biggest capability gap; injection + cost design required |
| B1 Agent Skills | High | Medium | Shipped (#741/#742) | Also reduces per-turn cached prefix; repo-bundled only |
| C1 Slash commands | High | Medium | Shipped (#744) | Cost + discoverability; Discord-only, keep read-only |
| D1 Helper handoff | High | Medium | Shipped (#729) | The one idea that pings people — opt-in is the feature |
| E1 Release watcher | High | Medium | Shipped (#739) | Public data, no privacy cost; ride the member digest |
| A2 Discord voice | Medium | Low | Shipped (#735) | Pure symmetry fix, machinery already exists |
| B2 Structured classifier output | Medium | Low | Shipped (#720, #831) | Fails-open regex on the safety path today |
| C2 Admin queue roll-up | Medium | Low | Shipped (#745) | Pure aggregation over existing scoped reads |
| D2 Answered→candidate loop | Medium | Low | Shipped (#726) | Closes the open middle of the flywheel |
| D3 Learning paths | Medium | Low | Not started | Probably a skill, not a new KB entry kind |
| F1 Answer eval | Medium | Medium | Shipped (#779) | Off CI, per RED-TEAM.md |
| B3 `fallbackModel` | Low | Low | Shipped (#738) | Degrade instead of fail |

## Deliberately not proposed

- **Member- or admin-authored skills at runtime.** A skill is instructions; the
  candidate-queue model that makes `suggest_knowledge` safe does not transfer.
- **Auto-posting into channels unprompted.** The open policy question that
  closed #636; E1 rides the existing member digest instead of reopening it.
- **Anything that infers member interests from message content.** #634 drew
  this line on purpose.
- **Outbound link fetching / previews.** #646 stores links as plain text and
  never fetches them; keep it.
- **New WhatsApp capabilities on the Baileys path** that raise ToS/ban risk.
