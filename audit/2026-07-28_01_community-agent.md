# Repository Audit — `swampratnz/community-agent`

**Date:** 2026-07-28
**Auditor:** Senior autonomous-agents engineer — structured follow-up review (evidence-based; audit only, no code changes)
**Commit reviewed:** `0f413ed` (HEAD of `main` at review time; work branch `claude/autonomous-agents-review-419tcg`)
**Prior audit:** `audit/2026-07-20_01_community-agent.md` (8 days earlier) — this pass verifies its resolutions, checks its deferred items, and hunts for new issues with an autonomous-agents-engineering lens.

---

> **Resolution status (updated 2026-07-28):** all eight actionable findings
> have shipped. **N1, N2, N3, N5, N6, N7, N8 → ✅ Resolved in #794**; **N4 →
> ✅ Resolved in #796**. The LOW items in the "Persistent deferred items" and
> "Additional new LOW items" tables below remain deferred except where a
> per-item Status says otherwise. Per-finding Status lines are inline in §3;
> §6's recommended sequence is therefore complete.

## 1. Executive summary

**Verdict:** Still production-viable and unusually well-hardened. The 2026-07-20 findings that were marked resolved *are* genuinely resolved (spot-verified H1, M2, M4, M5, M6, M7, M8, L8). No CRITICAL and no exploitable-now data-loss defect was found in the application. The most significant new items are in the **CI/agent pipeline**, not the bot: two loops that turn public GitHub comments into agent behaviour were hardened in one place (auto-merge) but the same author-check was **not** carried across to the sibling loops that write code.

**Top 3 priorities:**

1. **HIGH — Revise loop trusts an author-unchecked PR comment as "the review."** `pipeline-pr-revise.yml` selects the pending verdict from the *last comment whose body merely contains* `PR review (automated)`, with no author filter — the exact forgery the auto-merge loop was hardened against (`pipeline-pr-automerge.yml:264` matches `github-actions[bot]` + an `^`-anchored marker). On a public repo, an attacker's comment can become both the trigger source and the instruction sheet a write-capable `claude[bot]` agent implements on the PR branch.
2. **MEDIUM — Model-composed free-text reaches the trusted CONFIRM notice unsanitized.** The prior audit's M3 fixed nicknames in the two role tools, but `moderate` (`reason`), `create_event` (`name`/`location`), `cancel_event` (`reason`) and `suggest_issue` (`title`) still concatenate raw model-supplied strings — with newlines intact — into `pending.description`, which the router re-emits as the authoritative `⚠️ Pending:` notice. Same forgery class, same file's own `delete_message` already strips it.
3. **MEDIUM — Unauthenticated marker counting across autofix / revise / auto-merge.** Attempt caps and one-shot-notice guards count comments containing a public marker string with no author gate. Two hostile comments can force `needs-human` (pulling any bot PR out of every automated lane) or suppress the `human-merge-ready` escalation. The repo already solved this class in `scripts/pipeline-outcomes.mjs` — the fix is to copy that author gate.

**Findings:** 0 CRITICAL · 1 HIGH · 4 MEDIUM · ~14 LOW (plus doc-drift and process items). *(The 1 HIGH + 4 MEDIUM, plus LOW N6–N8, are all now resolved — see the resolution banner above and the per-finding Status lines below.)*

**Verification:** `npm ci` clean; `npm run typecheck`, `format:check`, `lint`, `context:check` all green; `npm test` = **2054 pass / 0 fail / 705 skipped** (skips are DB-gated with no local Postgres; CI runs them against a real `pgvector/pgvector:pg16`). `npm audit --omit=dev` = **2 moderate** (transitive `@hono/node-server` path-traversal via `@modelcontextprotocol/sdk`; Windows-only, `npm audit fix` available — see M4 below). `tests/reviewVerdict.test.ts` run directly: passes (verdict-contract copies are identical). The test suite has grown from ~1,580 passing to 2,054 in 8 days — discipline is keeping pace with pipeline velocity.

**Grade: B+ / A-.** The core security story (parameterized SQL, layered subtractive-then-re-asserted RBAC, deterministic CONFIRM, verified webhooks, sandboxed subprocess, thorough SSRF guard, real-DB tests, an injection corpus) is genuinely strong. Held back by: the pipeline author-check asymmetry above, the persistent god-module concentration (now *worse* — `tools.ts` 7,422 lines, `repository.ts` 7,033, together 44% of `src/`), and a cluster of agent-ergonomics gaps (a hand-duplicated prompt clause with no equality test, a context-pack coverage hole over the repo's hottest growth area).

---

## 2. What the 2026-07-20 audit resolved (verified this pass)

Confirmed genuinely fixed at current line numbers: **H1** (security-floor lowering guard `check-security-test-count.mjs:189-259` + baseline wiring `ci.yml:134-142` + CODEOWNERS covers `/scripts/` and `/tests/security-floor.json`), **M2** (GitHub PAT in `runtimeSecrets()` `secrets.ts:21` and pattern `outbound.ts:12`), **M3** (role tools use `resolveSanitizedLabel`), **M4** (Discord `ShardReady` handler `adapter.ts:369-372`), **M5** (Baileys stale-socket guards `baileysAdapter.ts:271,309` + reconnect-timer collapse), **M6** (dev-team poller `inFlight` latch `backgroundJobs.ts:622-635`), **M7** (`ci.yml:32-33` `permissions: contents: read`), **M8** (SSRF v4 denylist now includes `100.64.0.0/10` + the other reserved ranges `linkCheck.ts:73-88`), **L8** (`report_content` drops an unknown `targetUserId` `tools.ts:3334-3337`).

The verdict contract is intact: the three `canonical_verdict`/`legacy_verdict` copies are byte-identical modulo YAML indent, and `tests/reviewVerdict.test.ts` genuinely extracts and compares all three consumers.

---

## 3. New findings

### N1 — Revise loop resolves "the review" from an author-unchecked, unanchored comment (HIGH)

**Status:** ✅ Resolved in #794. The revise precheck's review-comment selection and attempt-count jq now author-gate on `github-actions[bot]` and `^`-anchor the marker (matching the auto-merge loop), and the agent prompt is told a same-marker comment from any other author is untrusted data, not the review.

**File:** `.github/workflows/pipeline-pr-revise.yml:144-145` (precheck), compounded at `:245-247` (agent prompt)
**Category:** Injection surface / verdict-contract integrity · OBSERVED

The revise precheck picks the pending verdict from the last comment that merely *contains* the marker, with **no author filter**:

```
review_body="$(jq -r '
  [.comments[] | select(.body | contains("PR review (automated)"))] | last | (.body // "")
' <<<"$info")"
```

Compare the auto-merge loop, hardened for exactly this class (`pipeline-pr-automerge.yml:264`):

```
[.comments[] | select((.author.login == "github-actions" or .author.login == "github-actions[bot]")
                       and (.body | test("^PR review \\(automated\\):")))] | last
```

The agent prompt then tells the revise agent to re-find it itself — *"the LATEST comment starting `PR review (automated)` lists the requested changes"* — with an authorship rule given for the diff but **not** for the review comment.

**Impact:** On a public repo any account can comment on an open build-worker PR with a body containing `PR review (automated)` + `<!-- verdict:CHANGES_REQUESTED -->` + attacker-authored "requested changes." A genuine Changes-requested verdict fires the dispatch; anything posted in the multi-minute window (precheck → checkout → `npm ci` → migrate) becomes both the pending-verdict source and the instruction sheet the revise agent implements and pushes to the PR branch as `claude[bot]`. Downstream gates (fresh CI, an author-checked LGTM for auto-merge, human merge) mean this is not merge-to-`main` by itself — but it converts a public comment into attacker-directed code on a pipeline branch, the precise thing the verdict contract's author-matching exists to prevent.
**Fix:** In the precheck jq add the same author filter + `^`-anchored `startswith`; pass the precheck-verified `review_body` into the prompt as quoted untrusted data (the handoff-note pattern) rather than telling the agent to re-find the latest matching comment.

---

### N2 — Model-supplied free-text fields reach the trusted CONFIRM notice unsanitized (MEDIUM)

**Status:** ✅ Resolved in #794. `requireConfirm` now strips the line/tag-forgery character class (`[<>\r\n…]`) from every pending-action description at a single choke point, covering all listed tools (and `forget_me`, N6). Pinned by a new `SECURITY:` test in `tools.test.ts`; documented in `docs/SECURITY.md`.

**File:** `src/agent/tools.ts:4510` (`moderate` `reason`), `:5082` (`create_event` `name`/`location`), `:5138` (`cancel_event` `reason`), `:6904` (`suggest_issue` `title`)
**Category:** Prompt-injection / CONFIRM-notice UI forgery · OBSERVED

The router deterministically re-emits `pending.description` as the authoritative `⚠️ Pending:` notice *because the model is untrusted* (`router.ts:1919-1936`, `pendingActions.ts:72-89`). Yet these free-text args flow into that description raw:

```ts
// tools.ts:4504-4510 — messageSuffix IS stripped, then raw args.reason is appended
const sanitized = content.replace(/[<>"\r\n]/g, ' ');       // delete_message preview: stripped
...
return requireConfirm(
  `${args.action} on ${args.targetUserId} in ${targetConversation}${messageSuffix} (reason: ${args.reason})`,  // args.reason: NOT stripped
  'admin', run,
);
```

`z.string()` on these fields applies only a max-length, never a charset filter. The same file already knows the fix — `delete_message`'s preview is stripped at `:4504` citing "the quarantine-escape class from issue #227," and M3 sanitized nicknames.

**Impact:** An injected/hijacked admin+ turn can embed newlines in `reason`/`name` to forge extra lines in the trusted notice a human reads before confirming (a fake second action line, or padding to bury the real one). Capped at MEDIUM because the true action verb+target is emitted first and verbatim — the model can *append* misleading text but cannot *remove or substitute* the real action — and all four tools are admin/super-admin-gated. Exact parity with the prior audit's M3.
**Fix:** Route these fields through the existing `.replace(/[<>"\r\n]/g, ' ')`, or — cleaner and future-proof — sanitize once inside `requireConfirm` (`tools.ts:2940`) so every current and future call site is covered. Add a `SECURITY:` test (newline in `moderate`'s `reason` cannot introduce a second notice line) and bump `security-floor.json`.

---

### N3 — Unauthenticated marker counting across autofix / revise / auto-merge (MEDIUM)

**Status:** ✅ Resolved in #794. Every marker count and dedup (autofix + revise attempt caps, auto-merge READY/BLOCKED) now filters to `github-actions[bot]`, matching the gate `scripts/pipeline-outcomes.mjs` already applied.

**File:** `pipeline-pr-autofix.yml:131`; `pipeline-pr-revise.yml:154-155`; `pipeline-pr-automerge.yml:345-346` (READY_MARKER), `:439-440` (BLOCKED_MARKER)
**Category:** Deterministic-loop robustness / griefing denial-of-automation · OBSERVED

Attempt caps and one-shot guards count comments containing a public marker string with no author gate:

```
attempts="$(gh pr view "$number" --json comments --jq "[.comments[] | select(.body | contains(\"$ATTEMPT_MARKER\"))] | length")"
```

The marker text is visible in the workflow file. Two comments from any account force the `>= 2` escalation → `needs-human`, which is the stop label for autofix, revise, conflict-resolver **and** auto-merge — one hostile commenter pulls any build-worker PR out of every automated lane. Auto-merge's `already_flagged`/`already_noted` checks are likewise authorless, so a pre-posted marker suppresses the `human-merge-ready` label+comment (the loop's only escalation for governance PRs, whose whole purpose is to be seen). The repo already fixed this exact class in `scripts/pipeline-outcomes.mjs:97-120` with a `MARKER_AUTHORS` gate and documents *why*.

**Impact:** Fails safe (work goes to a human, never merges), but it's a trivial unauthenticated denial-of-automation plus a notification-suppression primitive.
**Fix:** Apply the `pipeline-outcomes.mjs` author gate everywhere a marker is counted or deduplicated: `select((.author.login == "github-actions" or .author.login == "github-actions[bot]") and (.body | contains(...)))`.

---

### N4 — Build agent's `gh issue edit:*` grant is unscoped — bypasses the adversarial-review gate under injection (MEDIUM)

**Status:** ✅ Resolved in #796. `Bash(gh issue edit:*)` is removed from the build agent's `--allowedTools` entirely; the workflow now owns every lane transition deterministically with its `GITHUB_TOKEN` (Claim step → `status:building`, verify step → `status:built`, a git-ignored `needs-human.md` file-signal → `needs-human`). Scoped to the Action lane (the attended fallback Build Routine is documented as a separate model in `docs/PIPELINE.md`).

**File:** `.github/workflows/pipeline-build.yml:420` (allowedTools), trigger `:79`
**Category:** Token/permission scope / injection surface · OBSERVED

`Bash(gh issue edit:*)` cannot pin a target issue number, and the build agent reads untrusted issue comments (`:271`). An injected agent can run `gh issue edit <any> --add-label status:approved`; because it acts via the `claude[bot]` **App token** (not `GITHUB_TOKEN`), the `labeled` event *does* fire `pipeline-build.yml` (`:79`), spawning a full build of an arbitrary, never-adversarially-reviewed issue that ends in a `claude[bot]` `Closes #` PR — the shape every downstream loop treats as the vetted build-worker contract. The same grant lets it strip `needs-human` (the erased-escalation failure CLAUDE.md warns about). The deterministic workflow steps *already* perform the legitimate lane transitions with `${ISSUE_NUMBER}` (`:593`, `:636`), so the agent's grant is redundant for the safe path.

**Impact:** Collapses the human-adjacent approval lane into "one prompt injection of a running build." Bounded by the LLM review + fresh-LGTM/human merge, so not merge-to-`main` alone — but it removes the one deliberate adversarial-review gate and burns Max-pool budget on attacker-chosen builds.
**Fix:** Drop `gh issue edit:*` from the agent and let the deterministic steps own all lane transitions; or add a groundskeeper-style backstop that reverts + flags any `status:approved`/`status:building` label `claude[bot]` adds to an issue other than the one it is building.

---

### N5 — Wrong-dimension embedding model passes the health check while silently disabling all vector retrieval (MEDIUM)

**Status:** ✅ Resolved in #794. `embed()` now throws on a dimension mismatch (so the #376 health job trips on exactly this outage) instead of warn-and-return; `recordInteraction`'s existing catch keeps the audit row. Pinned by a new standalone test.

**File:** `src/storage/embeddings.ts:52-57`; `src/storage/repository.ts:79-92`; `src/backgroundJobs.ts:297-299`
**Category:** Correctness / monitoring blind spot · OBSERVED

`embed()` only `logger.warn`s on a dimension mismatch and returns the wrong-length vector. Startup's `verifyEmbeddingDim` compares config `EMBEDDING_DIM` against the *DB column*, never the model's actual output — so changing `EMBEDDING_MODEL` without `EMBEDDING_DIM` passes startup. Then every embedded insert fails and retries vector-less, every `searchMemory`/`searchKnowledge` throws in SQL and is caught into `return []`, and the dedicated embedding-health job (issue #376) calls `embed()` — which *succeeds* — so the monitor built to page an operator on a broken embedding subsystem reports green for exactly this failure.

**Impact:** Memory recall, knowledge search, dedup guards and clustering all silently degrade to empty results; only per-call warn logs signal it. Operator misconfiguration required; no security impact — but it defeats the health check that exists for it.
**Fix:** Have `embed()` **throw** on `vec.length !== config.db.embeddingDim` (the health job then trips and `recordInteraction`'s existing catch preserves the audit row), or assert the length in `defaultEmbeddingHealthCheckRun`.

---

### Persistent deferred items (still open, current line numbers)

| ID | Item | Status | Location |
|----|------|--------|----------|
| L1 | Bare `ROLLBACK` (no `.catch`); `client.release()` without destroy on error | **Partly fixed** — done at `repository.ts:1921`, `:2448`; still bare in `removeMember`/`linkMembers`/`unlinkMember` | `repository.ts:2062,2073,2173,2198,2209` |
| L2 | Per-conversation queue unbounded depth (stale-budget execution) | Still present | `router.ts:806-814` |
| L3 | Hard chunk cut can split a surrogate pair (`�` / Meta body reject) | Still present | `textChunk.ts:11-15` |
| L4 | Partial multi-chunk Discord send loses delivered message ids | Still present | `discord/adapter.ts:1038-1047` |
| L5 | `shutdown()` not idempotent; 2nd signal double-ends the pool; only drain is deadline-bounded | Still present | `index.ts:132-162` |
| L6 | `resumeFailed = /session\|resume/i.test(msg)` false-positives → discards healthy session | Still present | `core.ts:956` |
| L7 | Notice debounce latch set *before* send → failed send suppresses retry for the window | Still present | `router.ts:1190,1213,1257` |
| L13 | No `schema_migrations` table; whole `schema.sql` re-applied with ~20 in-place ALTERs | Still present | `migrate.ts:15-23` |
| L14 | God modules — now **worse**: `tools.ts` 7,422 ln (99 tools in one `buildToolServer`), `repository.ts` 7,033 ln; top 2 = 44% of `src/` | Grown | — |
| L15 | Duplication — the `lang/style` i18n ladder re-inlined ~8× (`router.ts` + `moderator.ts`); no shared `notices` helper | Still present | `router.ts:1194,1217,1261,…` |

### Additional new LOW items

- **N6 — `forget_me` interpolates the caller's raw display name into the CONFIRM notice** (`tools.ts:3300-3311`). **✅ Resolved in #794** — covered by N2's `requireConfirm` choke-point sanitiser. Lower than N2 because self-scoped (the notice is keyed to the caller's own confirm), but inconsistent with the file's own M3 discipline.
- **N7 — `startTrackedJob` / `startStatusCheck` pollers lack the M6 re-entrancy latch** (`backgroundJobs.ts:82-104`, `:390-425`). **✅ Resolved in #794** — the `inFlight` latch was hoisted into `startTrackedJob`, covering every tracked job. A docs-ingest run can plausibly exceed the 6h tick (up to `DOCS_INGEST_MAX_PAGES=2500`), letting a second concurrent ingest start before the first writes its freshness stamp.
- **N8 — Baileys `group-participants.update` handler missing the M5 stale-socket guard** (`baileysAdapter.ts:316-320`). **✅ Resolved in #794** — the `if (this.sock !== sock) return;` guard was added. Bounded anyway (roster upsert idempotent, welcome cooldown-latched).
- **N9 — LID-routed WhatsApp DMs invisible to `conversationsForUser` scoping for phone-resolved users** (`baileysAdapter.ts:331` vs `:945-949`). Under-scopes only (rows invisible, never over-exposed — the safe direction). Fix: include the `<lid>@lid` DM key via the existing `lidToPhone` reverse lookup.
- **N10 — SSRF v6 denylist misses hex-form v4-mapped literals (`::ffff:7f00:1`) and `64:ff9b:1::/48` NAT64** (`linkCheck.ts:113-129`). No demonstrated bypass (DNS renders v4-mapped answers dotted; v4 denylist verified complete); belt-and-braces on the exported guard.
- **N11 — Cloud webhook doesn't check `phone_number_id` against config** (`cloudWire.ts:119-147`). HMAC proves "from Meta for this app"; a multi-number app would route all numbers' traffic in as first-party. Single-number deploys unaffected; no spoofing path (identity is Meta-attested `msg.from`). Fix: filter on `value.metadata.phone_number_id`.
- **N12 — Auto-merge review "freshness" compares committer-date, not push time** (`pipeline-pr-automerge.yml:312-317`). Its safety actually rests on the empty-`statusCheckRollup` checks-gate, not the date comparison; docs claim the stronger property. No live stale-LGTM path found. Fix: compare check/status timestamps or `pushedDate`, or document the checks-gate dependency.
- **N13 — Security-floor baseline guard: rename + compensating trivial addition slips both prongs; `{ skip: true }` option-form not banned** (`check-security-test-count.mjs:176-187,217-251`). Residual on a defense-in-depth gate (needs the reviewer to miss an odd diff), not a hole in the primary gate. Fix: flag any baseline-key removal for the label; extend the banned-skip matcher to the options-object form.
- **N14 — `@hono/node-server < 2.0.5` path traversal (GHSA-frvp-7c67-39w9), transitive via `@modelcontextprotocol/sdk`** — 2 moderate, Windows-only (`%5C`), this service runs on Ubuntu. Low real risk but `npm audit fix` is clean; take it on the next dependency PR.

---

## 4. Agent-ergonomics & process (pipeline throughput / agent quality)

These aren't bugs; they're where a mature autonomous-agents repo would tighten next. Each names the file to change.

**High impact:**

1. **Context-pack coverage hole over the hottest area.** `docs/agents/module-map.md` itemizes five `src/agent/*` files but omits `src/agent/skills/` (6 SKILL.md files, 3 added in the last two days), `src/agent/personas.ts`, and `src/agent/secrets.ts` (🔒 security spine). The gate permits extra entries — add the three lines. A cold session asked to add a seventh skill currently gets zero orientation.
2. **`recipes.md` is missing the two recipes agents now need most:** "change the system prompt / add an Agent Skill" (the most safety-sensitive change class — touchpoints `systemPrompt.ts`, `injectionCorpus.json`, `agentSkillsEnabled.test.ts`, RED-TEAM sweep) and "add knowledge-discoverable content → add a golden query" (CLAUDE.md mandates it; recipes never mentions `knowledgeEval.json`).
3. **`PROMPT_REVIEW_CLAUSE` is hand-duplicated with no equality test.** `systemPrompt.ts:160` and `src/agent/skills/prompt-review/SKILL.md` are maintained by hand; `agentSkillsEnabled.test.ts` only asserts the flag-on prompt *lacks* the checklist, never that the two copies match — an edit to one silently forks behaviour between flag states. Worse, the SKILL.md copy says "attribute per the provenance rule **above**" / "code policy **below**" — positional references that dangle when the SDK loads the file standalone. Fix: add an equality test; rewrite the two positional references to name their targets.
4. **CLAUDE.md duplicates ~185 lines of PIPELINE.md verbatim** (incident quotes and all), and `recipes.md` mandates keeping them in sync — a standing double-maintenance tax every cold session also pays in tokens. The duplicated detail is all YAML-enforced; an agent never needs it from CLAUDE.md to act. Fix: cut CLAUDE.md's pipeline section to the ownership rule + a loop→one-line table + "see docs/PIPELINE.md," and make the sync rule "point, don't copy."
5. **Observability blind spots:** cost-per-merged-PR is unaggregated (turns/duration go only to each run's step summary — PIPELINE.md calls the turn count "the number to watch," but nothing watches it); no review-quality loop (LGTM'd-then-reverted, human overrides, revise-rounds distribution — all countable from the machine-readable verdict token); no dead-Routine detection for research/adversarial (the heartbeat is explicitly temporary). Fix: extend `pipeline-outcomes.mjs` with a per-PR attempts×turns rollup and a verdict-outcome section.

**Medium impact:** the paraphrase requirement for golden queries is convention-only (add a token-overlap guard test); untested agent behaviours worth an off-CI eval case group (`rate_answer` trigger precision, moderation-classifier false-positive corpus, persona voice drift) via `answersEval.json`; a direct CLAUDE.md contradiction ("no model identifiers in code" vs `config.ts:34` `AGENT_MODEL` default — reword to "don't identify the *authoring* model; product config is exempt"); model-revision pinning for the embedding model (`embeddings.ts:7` name-pinned, not revision-pinned — an upstream HF revision shifts every stored vector's space).

**Low impact:** a one-page `docs/INCIDENTS.md` index (incident memory is rich but sharded across YAML comments and doc prose — recipes.md even warns "several are the only record of an incident"); PIPELINE.md carries a legacy `/loop` build prompt that now contradicts the live Actions prompt ("leave the PR as draft; do NOT merge" — the live worker opens a normal PR); a `PROMPT_REVISION` marker in `systemPrompt.ts` logged at startup so a helpful-rate dip can be aligned to a prompt change.

---

## 5. What's good (calibration)

The prior audit's "what's good" list still holds. Additionally verified this pass:

- **Tool gating is structurally sound and defense-in-depth.** `toolsForRole` is tier-derived and only ever subtractive; every privileged handler *additionally* re-asserts tier via `assertAtLeast` (70+ sites); no tool derives tier from message content; cross-platform management correctly escalates to `super_admin`.
- **No classic Actions injection anywhere.** A full scan found no untrusted `${{ }}` (titles/bodies/branch names) interpolated into `run:` bodies — they consistently pass via `env:` with explanatory comments.
- **`handoff-note.mjs` matches every documented containment claim** (bot-author-only with `[bot]`-suffix normalization, marker-must-be-line-1, 4000-char line-boundary truncation, control-token stripping, `| `-prefix quoting, double sanitization). The resume-pointer and checkpoint mechanisms are genuinely layered and fast-forward-only as documented.
- **The eval story is a coherent three-layer separation:** deterministic injection corpus (CI-blocking, no model), retrieval quality against real pgvector with distractors + negative queries, and answer grounding through the real agent turn (correctly enforced off-CI). Unusually disciplined.
- **The production→knowledge feedback loop is genuinely closed with a human commit gate** (interactions → nightly digest → PII-scrubbed k-floored export → human-reviewed commit → research grounds proposals in it), and the PII/k-floor boundary holds on inspection (`export.ts:84,105-113`; floors zod-enforced `>=2`).

---

## 6. Recommended sequence

*All five items below shipped across #794 (items 1, 2, 4, and the ergonomics batch minus the CLAUDE.md/PIPELINE.md de-duplication) and #796 (item 3). Retained as the record of the intended order.*

1. **✅ (#794) Close the pipeline author-check asymmetry (N1 HIGH + N3 MEDIUM) together** — one reviewable diff that copies the `pipeline-outcomes.mjs` / auto-merge author gate to the revise precheck and every marker count. This is the highest-severity item and the cheapest structural fix. Governance-path change → human merge.
2. **✅ (#794) Sanitize CONFIRM-notice free-text once inside `requireConfirm` (N2 + N6 MEDIUM/LOW)** — a single choke-point fix covering every current and future call site, with a `SECURITY:` regression test and a `security-floor.json` bump.
3. **✅ (#796) Drop the build agent's `gh issue edit:*` grant (N4 MEDIUM)** — the deterministic steps already own the safe transitions; removing it closes the adversarial-gate bypass at zero functional cost. Also governance-path.
4. **✅ (#794) `embed()` throws on dimension mismatch (N5)** and **hoist the `inFlight` latch into `startTrackedJob` (N7)** — two small robustness fixes for the operator-error and long-run classes.
5. **◐ (#794, partial) Agent-ergonomics batch (§4 items 1–4)** — context-pack entries, the two missing recipes, and the `PROMPT_REVIEW_CLAUSE` equality test shipped; the CLAUDE.md/PIPELINE.md de-duplication was **deferred** (left as a standalone doc change). These lower the standing token cost and drift risk of the pipeline itself.

**Still open** (deferred by design): the remaining LOW items (L1–L7, L13–L15, N9–N14) and the deferred ergonomics/de-duplication work — each its own focused change.
