# Repository Audit — `swampratnz/community-agent`

**Date:** 2026-07-20
**Auditor:** Principal-engineer structured review (evidence-based; audit only, no changes made)
**Commit reviewed:** `241b9cc` (branch `claude/repository-security-audit-s5sawz`, forked from `main`)

---

## 1. Executive summary

**Verdict:** Production-viable and unusually well-hardened for its size; no exploitable-now or data-loss defect was found. The debt is concentration (3 files = 48% of `src/`) and a cluster of second-order hardening gaps.

- **Top risk 1 (HIGH):** a `SECURITY:`-test deletion plus a `security-floor.json` edit in one PR passes CI green and is *auto-merge-eligible* — no human review is structurally forced on the security gate itself.
- **Top risk 2 (MEDIUM):** the CONFIRM/CANCEL flow silently breaks for actions raised in an auto-answer thread (keys under the wrong conversation id); fails safe but the shipped feature is dead in-thread.
- **Top risk 3 (MEDIUM):** the fine-grained GitHub PAT is exempt from both the exact-value and the pattern-based outbound secret redaction layers.

**Overall grade: B+.** Genuinely strong core security (parameterized SQL throughout, layered RBAC, deterministic CONFIRM, verified webhooks, sandboxed subprocesses, real-DB tests) held back one grade by god-module concentration and the auto-merge/CODEOWNERS gap on the security spine.

**Findings:** 0 CRITICAL · 1 HIGH · 8 MEDIUM · 15 LOW.

**Verification note:** `npm run typecheck` clean; `npm audit` **0 vulnerabilities** (prod + dev); git history (314 commits) and working tree carry **no secrets**. Full test suite: 1578 pass, 537 skipped (DB-gated), 1 fail + 8 cancelled — all environmental (no local Postgres on `:5432`, HuggingFace model download blocked in the sandbox), not code defects; CI runs these against a real `pgvector/pgvector:pg16` container. **No coverage tooling (c8/nyc/istanbul) is configured**, so no coverage percentage can be reported — see M8.

---

## 2. Architecture map

**What it is.** A single long-running TypeScript/Node ≥22 service ("Dave") that bridges a Discord server and a WhatsApp number to a Claude Agent SDK agent, with Postgres + pgvector for retrieval-augmented memory and a three-tier RBAC model (super_admin > admin > member > guest). Deployed as a systemd unit on Ubuntu, authenticated against a Claude *subscription* (OAuth token, no per-token API billing). Local embeddings via transformers.js (`all-MiniLM-L6-v2`, 384-dim). WhatsApp is pluggable: Baileys (unofficial, default) or the official Meta Cloud API.

**Entry point & flow.** `src/index.ts` (crash handlers → config → DB dim check → adapters → background-job timers) → adapters normalise inbound to `IncomingMessage` → `src/router.ts` (record, gate, per-conversation serialize, rate-limit, CONFIRM intercept) → `src/agent/core.ts` (memory recall → role-scoped prompt → role-gated `query()` → outbound filter) → `src/storage/`.

**External dependencies.** Anthropic Agent SDK (subscription OAuth); Discord gateway (`discord.js` v14); WhatsApp (Baileys / Meta Graph API webhook); Postgres+pgvector; optional egress — Anthropic docs/status pages (SSRF-guarded), a tailnet dev-team build service (bearer), Grok CLI (image gen, sandboxed subprocess), a fine-grained GitHub PAT (issue filing).

**Secrets.** All via env, validated once in `src/config.ts` (127 vars, zod, fail-fast). `runtimeSecrets()` feeds an outbound redaction backstop.

**Docs vs. reality.** The docs are exceptionally detailed and, where spot-checked, accurate. Two divergences worth noting: `docs/ARCHITECTURE.md` still describes RBAC roles as `admin`/`user` in the component table (line 49) while the code implements a four-tier `Tier`; and the CONFIRM-in-threads flow documented as working (issue #519) is defective (see H/M findings). Neither is a code bug in itself.

---

## 3. Findings table

**Resolution status:** H1 + M1–M8 are all **✅ resolved** in this PR (see the
per-finding **Status** lines in §4 and §5). The 15 LOW items are **⬜ deferred**
(hygiene/robustness, out of scope for this pass).

| ID | Severity | Status | Location | Description |
|----|----------|--------|----------|-------------|
| H1 | HIGH | ✅ Resolved | `scripts/check-security-test-count.mjs:129`; `.github/workflows/pipeline-pr-automerge.yml:175-179`; `.github/CODEOWNERS` | Security-test deletion + floor edit passes CI and is auto-merge-eligible with no forced human review |
| M1 | MEDIUM | ✅ Resolved | `src/router.ts:862-865, 937-940` | CONFIRM/CANCEL & escalation-yes unmatchable for actions raised in an auto-answer thread |
| M2 | MEDIUM | ✅ Resolved | `src/agent/secrets.ts:8-18`; `src/agent/outbound.ts:11` | Fine-grained GitHub PAT exempt from both outbound-redaction layers |
| M3 | MEDIUM | ✅ Resolved | `src/agent/tools.ts:5049, 5082` | `assign/remove_community_role` inject a raw display name into the trusted CONFIRM notice |
| M4 | MEDIUM | ✅ Resolved | `src/platforms/discord/adapter.ts:292-316` | `connected` flag can stick `false` after an unresumable gateway reconnect (no `ShardReady` handler) |
| M5 | MEDIUM | ✅ Resolved | `src/platforms/whatsapp/baileysAdapter.ts:175-266` | Baileys reconnect handlers have no socket-identity guard; stale-socket `close` can churn a healthy socket |
| M6 | MEDIUM | ✅ Resolved | `src/backgroundJobs.ts:559-581` | Dev-team watch poller (1-min tick) has no re-entrancy latch → overlap → duplicate completion DMs |
| M7 | MEDIUM | ✅ Resolved | `.github/workflows/ci.yml` (no `permissions:`) | Fork-PR-triggered CI runs untrusted code with the repo-default `GITHUB_TOKEN` scope |
| M8 | MEDIUM | ✅ Resolved | `src/context/linkCheck.ts:73-79` | SSRF v4 denylist omits `100.64.0.0/10` (CGNAT / Tailscale) — the tailnet this deploy uses |
| L1 | LOW | ⬜ Deferred | `src/storage/repository.ts:1950-1955, 2050-2091` | Bare `ROLLBACK` (no `.catch`) can mask root error and return a poisoned client to the pool |
| L2 | LOW | ⬜ Deferred | `src/router.ts:692-700` | Per-conversation queue has unbounded depth (staleness/memory under load) |
| L3 | LOW | ⬜ Deferred | `src/platforms/textChunk.ts:11-16` | Hard-cut chunk can split a surrogate pair → `�` / Meta rejects body |
| L4 | LOW | ⬜ Deferred | `src/platforms/discord/adapter.ts:745-765` | Partial multi-chunk send discards ids of chunks already delivered (no retraction/budget record) |
| L5 | LOW | ⬜ Deferred | `src/index.ts:124-152` | Shutdown not idempotent; second signal double-ends the pool; only drain is time-bounded |
| L6 | LOW | ⬜ Deferred | `src/agent/core.ts:704-707` | `resumeFailed` regex `/session|resume/i` false-positives → discards healthy session |
| L7 | LOW | ⬜ Deferred | `src/router.ts:1024, 1047, 1091, 1586` | Notice debounce latch set *before* send; a failed send suppresses retry for the whole window |
| L8 | LOW | ⬜ Deferred | `src/agent/tools.ts:2556-2559` | `report_content` accepts an unverified `targetUserId` → member can hide a report from an accused admin |
| L9 | LOW | ⬜ Deferred | `deploy/setup-ubuntu.sh:27, 46-54` | `curl | bash` as root (NodeSource); unquoted `DB_USER`/`DB_NAME` in `psql` heredoc |
| L10 | LOW | ⬜ Deferred | `deploy/community-agent.service`; `-redeploy.service` | systemd hardening incomplete; redeploy unit runs as root unhardened |
| L11 | LOW | ⬜ Deferred | `.github/workflows/pipeline-pr-automerge.yml:178` | Governance-path check reads `gh pr view --json files` (≤100 cap) → fails open on >100-file PR |
| L12 | LOW | ⬜ Deferred | `tsconfig.json`; `eslint.config.js` | `no-unsafe-*` family off, `noUncheckedIndexedAccess` off — no `any`-guard on untrusted-input paths |
| L13 | LOW | ⬜ Deferred | `src/storage/migrate.ts` + `schema.sql` | No migrations table; re-applies schema with 18 in-place ALTERs → fresh-vs-upgraded parity by convention |
| L14 | LOW | ⬜ Deferred | `src/agent/tools.ts` (5,970 ln); `repository.ts` (5,621 ln); `router.ts` (1,728 ln) | God modules: 3 files = 48% of `src/`; `buildToolServer` ≈3,800 lines |
| L15 | LOW | ⬜ Deferred | `src/rateLimitNotice.ts:32` +3; `router.ts` (~8×); tests (53× `makeAdapter`) | Duplication: 4-way debounce clone, ~8× inlined i18n ladder, no shared test harness |

---

## 4. Detailed findings

### H1 — Security-test deletion can reach `main` with no forced human review (HIGH)

**Location:** `scripts/check-security-test-count.mjs:126-142`; `.github/workflows/pipeline-pr-automerge.yml:165-182`; `.github/CODEOWNERS:6-12`
**Category:** CI/CD governance · OBSERVED (composed from three verified facts)

**Status:** ✅ Resolved in this PR. (2) `/tests/security-floor.json` and `/scripts/` added to `CODEOWNERS`. (3) `check-security-test-count.mjs` now refuses a per-file count that is LOWERED vs the PR base (`SECURITY_FLOOR_BASELINE_REF`, wired from `ci.yml` on `pull_request` with `fetch-depth: 0`) unless an explicit `allow-security-floor-lower` label is set — so a deleted SECURITY test + lowered manifest can no longer pass CI green. Fix (1) — adding `security-floor.json` to the auto-merge governance regex — was intentionally NOT applied: the loop deliberately excludes per-PR data files, and the CI lowering guard closes the actual hole precisely (for both auto- and human-merged PRs) without forcing a human merge on every count-*raising* PR. The branch-protection "require human review" setting remains the enforceable backstop.

The plain `test:security` gate CI runs enforces an **exact** match, not a floor:

```js
// check-security-test-count.mjs:129
if (actual < expected) { problems.push(...) }      // fewer than declared
else if (actual > expected) { problems.push(...) } // more than declared
```

So a PR that **deletes a `SECURITY:` test *and* lowers that file's count in `tests/security-floor.json` in the same diff stays green.** The lowering guard (`--allow-lower`) lives only in the `--write` helper path (`:106-114`), which CI does not run.

This composes with two coverage gaps, both verified:
- The auto-merge governance-path exclusion (`pipeline-pr-automerge.yml:179`) deliberately **omits** `tests/security-floor.json` and `tests/` — the inline comment (`:175-177`) states this is intentional because those are "per-PR DATA nearly every PR touches."
- `CODEOWNERS` covers `/.github/`, `/src/auth/`, three `src/agent/*.ts` files and `schema.sql` — but **not** `/tests/`, `tests/security-floor.json`, or `/scripts/` (the gate script itself).

**Failure scenario:** a build-worker PR (from an approved issue) removes a `SECURITY:` invariant test and drops the matching manifest count. `test:security` passes, no CODEOWNER is auto-requested for the change, and if the LLM review worker emits `LGTM`, the deterministic auto-merge loop merges it to `main` unattended. The gate that exists to prevent silent security regressions is itself silently removable.
**Trigger:** any PR in the automated pipeline (or a human PR) that edits both a test file and `security-floor.json`.
**Fix:** (1) add `tests/security-floor.json` to the auto-merge governance-path regex at `pipeline-pr-automerge.yml:179` so any manifest change forces a human merge; (2) add `/tests/security-floor.json` and `/scripts/` to `CODEOWNERS`; (3) make the plain CI check treat a *lowering vs. the committed manifest's git-base* as a hard failure unless an explicit `allow-lower` marker is present, mirroring the `--write` guard.
**Residual-risk note:** the documented backstop is branch protection on `main` requiring a human *review*. If that setting is actually enabled, real-world severity drops to MEDIUM; it could not be verified from the repo (it is a GitHub settings-side control), so this is rated on the code/config as committed.

---

### M1 — CONFIRM/CANCEL unmatchable for actions raised inside an auto-answer thread (MEDIUM)

**Location:** `src/router.ts:862-865` (confirm intercept) and `:937-940` (escalation intercept); registration at `src/agent/tools.ts:2235`
**Category:** State-keying correctness · OBSERVED (logic traced end-to-end); user impact INFERRED

**Status:** ✅ Resolved in this PR. Both intercepts (`router.ts` confirm + escalation) now prefer the message’s OWN conversation id and fall back to the parent only on a miss, so a CONFIRM/escalation-yes typed inside an auto-answer thread resolves the thread-keyed action instead of a guaranteed miss. Pinned by a new `SECURITY:` regression test in `autoAnswerThreadFollowupRouter.test.ts` (and the origin-post fallback case is preserved).

The confirm intercept unconditionally rewrites a message from a known auto-answer thread back to the **parent** channel before lookup:

```ts
// router.ts:862-865
const pendingConversationId =
  this.autoAnswerThreadParents.get(msg.conversationId)?.parent ?? msg.conversationId;
const verdict = classifyConfirmReply(msg.text);
if (verdict && hasPendingAction(msg.platform, pendingConversationId, msg.userId)) {
```

That is correct for the origin-post case. But issue #519 also runs full turns for **follow-ups typed inside the thread**, where `caller.conversationId` is the *thread id*, so `requireConfirm` registers the pending action under the **thread id** (`tools.ts:2235`) and `offerEscalation` keys on the thread id. When the user types `CONFIRM`/`yes` in that thread, the intercept translates thread → parent and looks up under the parent key — a guaranteed miss. Typing it in the parent also misses (action is under the thread id). The `⚠️ Pending:` notice is still shown (peeked under the thread id at `:1639`, which matches), so the user is explicitly invited to confirm an action they cannot confirm anywhere. It self-heals only after the 10-min `autoAnswerThreadParents` TTL lapses.

**Trigger:** `AUTO_ANSWER_CHANNEL_IDS` set; a member/admin posts a follow-up *inside* a bot-opened auto-answer thread that registers a CONFIRM-gated (destructive) action, then replies CONFIRM within the live window.
**Impact:** fails safe (never executes the wrong action), but destructive-action confirm and admin escalation are silently dead in-thread; the stray token is billed as an extra model turn.
**Fix:** prefer the message's own conversation id, fall back to the parent only on a miss, at both `:862-865` and `:937-940`:

```ts
const hasHere = hasPendingAction(msg.platform, msg.conversationId, msg.userId);
const pendingConversationId = hasHere
  ? msg.conversationId
  : (this.autoAnswerThreadParents.get(msg.conversationId)?.parent ?? msg.conversationId);
```

---

### M2 — Fine-grained GitHub PAT exempt from outbound secret redaction (MEDIUM)

**Location:** `src/agent/secrets.ts:8-18`; `src/agent/outbound.ts:11`
**Category:** DLP / secret handling · OBSERVED (defense-in-depth backstop gap)

**Status:** ✅ Resolved in this PR. `config.github.token` added to `runtimeSecrets()`, and `/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g` added to `SECRET_PATTERNS`. Two new `SECURITY:` tests in `secrets.test.ts` cover the exact-value and pattern layers.

`runtimeSecrets()` enumerates seven exact-value secrets that must never leave the process — but **`config.github.token` is not among them.** The pattern layer matches classic tokens only:

```ts
// outbound.ts:11
/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,   // ghp_/gho_/... — NOT github_pat_
```

`.env.example` (line 110) and `src/github/issues.ts:4-6` **require** the token to be a fine-grained PAT, whose format is `github_pat_…` — precisely what both the exact-value list and the regex miss.

**Failure scenario:** today the token is only sent in a request header and the `suggest_issue` path redacts it explicitly (`tools.ts:5438`), so there is no live leak. But `runtimeSecrets()` is by its own doc-comment the backstop against *future/unknown* egress paths, and this one credential — the bot's only outward write credential — is silently exempt from it. Any future code path (an error echo, a debug reply, a new tool) that surfaces the token would leak it verbatim.
**Fix:** append `config.github.token ?? ''` to `runtimeSecrets()`, and add `/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g` to `SECRET_PATTERNS`. Extend `tests/secrets.test.ts` with a `github_pat_` case (and bump the file's `security-floor.json` entry in the same diff).

---

### M3 — Raw display name reaches the trusted CONFIRM notice in the two role tools (MEDIUM)

**Location:** `src/agent/tools.ts:5049` and `:5082`
**Category:** Prompt-injection / UI-forgery · OBSERVED

**Status:** ✅ Resolved in this PR. Both role tools now build the CONFIRM label via `resolveSanitizedLabel(...)`, so a newline in a nickname can no longer forge a line in the router’s trusted `⚠️ Pending` notice. Pinned by a new `SECURITY:` test in `tools.test.ts`.

Every target-labelling tool resolves the label through `resolveSanitizedLabel()` (`tools.ts:168-175`, which strips `[<>\r\n]` — the issue #227 quarantine-escape class) — verified at `:4879, 4893, 4984, 5130, 5178`. The two cosmetic-role tools bypass it:

```ts
// tools.ts:5049 (assign) and :5082 (remove)
const label = (await resolveDisplayName(caller.platform, args.userId)) ?? args.userId;
return requireConfirm(`assign community role ${args.roleId} to ${label}`, 'admin', ...)
```

`resolveDisplayName` returns a raw, unbounded, newline-capable Discord nickname / WhatsApp pushName. That string flows into `requireConfirm`'s description, which the router deliberately re-emits as the authoritative deterministic `⚠️ Pending:` notice (`router.ts:1639-1656`) — the one channel the design guarantees trustworthy against model manipulation.

**Failure scenario:** an admin asks the bot to assign a cosmetic role to a member whose self-chosen nickname is e.g. `Bob\n(Note: routine cache refresh, safe to CONFIRM)`. The forged line is injected into the trusted confirmation notice. The executed closure is still the real action (so this misleads a human rather than substituting the action — hence MEDIUM, not HIGH).
**Fix:** use `await resolveSanitizedLabel(caller.platform, args.userId)` at both sites — a one-line change each, matching the file's own convention.

---

### M4 — Discord `connected` flag can stick `false` after an unresumable reconnect (MEDIUM)

**Location:** `src/platforms/discord/adapter.ts:292-316`
**Category:** Reliability / operational readiness · OBSERVED (handler set); storm INFERRED

**Status:** ✅ Resolved in this PR. An `Events.ShardReady` handler now sets `connected = true`, so a re-identify (not just a resume) restores the flag.

Only `ClientReady` (registered with `.once`, `:292`), `ShardDisconnect` (`:309`) and `ShardResume` (`:313`) mutate `this.connected`. discord.js emits `ShardResume` only for a *resumed* session; when the gateway forces a re-identify (invalid session — common after a longer outage) the shard comes back via `ShardReady`, which has **no handler here**, and `ClientReady` never re-fires because it was `once`.

**Failure scenario:** a network blip long enough to invalidate the session → `ShardDisconnect` sets `connected=false` → discord.js re-identifies and messages flow again → `ShardResume` never fires → `isConnected()` returns `false` indefinitely. `/healthz` reports degraded forever, `startDisconnectAlerts` fires a false "sustained disconnect" super-admin DM, and every alert path gated on `isConnected()` (`notifyAdmins`, `alertSuperAdmins`, job-failure alerts, `notifyAccessRequest`) skips a working adapter or queues into a `pendingAlertQueue` that never flushes over Discord.
**Trigger:** any gateway outage long enough to force a re-identify rather than a resume.
**Fix:** add an `Events.ShardReady` handler that sets `this.connected = true`, or replace the manual flag with `this.client.isReady()` / live ws-status checks.

---

### M5 — Baileys reconnect handlers lack a socket-identity guard (MEDIUM)

**Location:** `src/platforms/whatsapp/baileysAdapter.ts:175-266` (esp. `:202, 223-252`)
**Category:** Reliability / event-handler lifecycle · OBSERVED (missing guard); storm INFERRED (Baileys 6.7.23 re-emit behaviour)

**Status:** ✅ Resolved in this PR. `connection.update` and `messages.upsert` closures now early-return when `this.sock !== sock`, and the pending reconnect timer is tracked and cleared on a successful open (and collapsed on re-schedule), so a stale socket’s `close` can’t churn a healthy one.

`connect()` attaches `connection.update` / `messages.upsert` to each new socket, never removes the previous socket's listeners, and the handlers mutate shared state (`this.connected`, `scheduleReconnect()`) without checking `sock === this.sock`. The teardown `this.sock?.end(undefined)` may emit `close` on the *old* socket after replacement socket B is open.

**Failure scenario:** a late `close` from socket A flips `this.connected=false` while B is healthy, and `scheduleReconnect()` queues a `connect()` that will `end()` healthy B — whose own close handler schedules yet another reconnect. Worst case is periodic churn of healthy sockets; best case is a transiently wrong `isConnected()` (queued alerts, degraded `/healthz`). Two overlapping scheduled reconnects (possible when `connect()` throws and re-schedules at `:181-186`) make it more likely.
**Fix:** add `if (this.sock !== sock) return;` at the top of the `connection.update` (and ideally `messages.upsert`) closures, and clear any pending reconnect timer on a successful open.

---

### M6 — Dev-team watch poller can overlap and double-send completion DMs (MEDIUM)

**Location:** `src/backgroundJobs.ts:559-581` (scheduler) and `:467-532` (`runDevTeamWatchOnce`)
**Category:** Idempotency / job scheduling · OBSERVED

**Status:** ✅ Resolved in this PR. An `inFlight` re-entrancy latch now skips a tick while the previous pass is still running, so overlapping passes can’t double-send completion DMs.

`startDevTeamWatchPoller` fires from a bare `setInterval` every `watchPollMinutes` (**default 1 minute**) with no in-flight guard. Each pass does, per watch, a sequential `getStatus` (+ `getResult`) + `sendDirectMessage` + `markNotified`, and the DM is sent **before** the stamp (`:518-530`). With several watches and a slow tailnet/Graph round-trip a pass can exceed 60 s, so two passes run concurrently, both read the same unnotified rows before either stamps, and the "rare duplicate DM" the comment allows becomes systematic under latency.
**Trigger:** `DEV_TEAM_ENABLED` with multiple in-flight watches and normal tailnet latency.
**Fix:** add a re-entrancy latch (`if (running) return;` / `try … finally { running=false }`) around the interval body — the same pattern the other pollers would benefit from.

---

### M7 — `ci.yml` runs fork-PR code with no `permissions:` block (MEDIUM)

**Location:** `.github/workflows/ci.yml` (triggers on `pull_request`, `:6`; no `permissions:` key anywhere — verified)
**Category:** CI/CD least-privilege · OBSERVED (missing block); token scope INFERRED (depends on repo default)

**Status:** ✅ Resolved in this PR. A top-level `permissions: { contents: read }` block added to `ci.yml` (all three jobs are read-only).

`ci.yml` triggers on `pull_request` (includes forks) and executes attacker-controlled code: `npm ci` (runs PR `package.json` lifecycle scripts), `npm run migrate`, `npm test`, `npm run build`. With no `permissions:` block the job inherits the **repo/org default** `GITHUB_TOKEN` scope, which on older repos is read/write across all scopes.

Mitigations present and verified: every checkout uses `persist-credentials: false` (token not written to `.git/config`) and `GITHUB_TOKEN` is not injected into the `run:` step env, so a malicious npm script cannot trivially read it. Residual: a fork-code-executing workflow relying on a repo-level default is fragile — one settings change re-widens it.
**Fix:** add top-level `permissions: { contents: read }` to `ci.yml` (all three jobs are read-only).

---

### M8 — SSRF v4 denylist omits the CGNAT/Tailscale range this deploy uses (MEDIUM)

**Location:** `src/context/linkCheck.ts:73-79`
**Category:** SSRF · OBSERVED

**Status:** ✅ Resolved in this PR. `100.64.0.0/10` (CGNAT/Tailscale) plus `0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, multicast `224.0.0.0/4`, and reserved `240.0.0.0/4` added to `DISALLOWED_V4_CIDRS`. The existing `SECURITY:` denylist test was extended to cover them (and the just-outside-range publics).

The IPv4 denylist covers loopback/RFC-1918/link-local but omits **`100.64.0.0/10`** (CGNAT — the Tailscale address space), plus `0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, and multicast/reserved. This repo *explicitly* runs a bearer-token dev-team service on the tailnet (`config.ts` dev-team block; `.env.example:129-137`).

**Failure scenario:** an **admin** (not super-admin) sets a knowledge entry's `sourceUrl` to a hostname resolving to a `100.x.y.z` tailnet address; the guard passes it and the weekly link-checker returns a reachable/unreachable boolean — a blind host/port probe oracle over the tailnet, exactly what the guard's own header says it prevents. Constraints keeping this MEDIUM: admin-only, HTTPS-only (`:142`), boolean-only signal, weekly cadence, and the IPv6 side is otherwise thorough (DNS pinned against rebinding, every redirect hop re-guarded).
**Fix:** add `['100.64.0.0', 10]` (and ideally the other reserved ranges above) to `DISALLOWED_V4_CIDRS`.

---

## 5. MEDIUM / LOW summary (remaining)

The MEDIUMs above are the actionable set; the LOWs below are hygiene / robustness, each OBSERVED unless marked.

- **L1** `repository.ts:1950-1955, 2050-2091` — `removeMember`/`linkMembers`/`unlinkMember` do `await client.query('ROLLBACK'); throw err` with no `.catch`; if ROLLBACK rejects it masks the root error, and `client.release()` (no arg) can return a client stuck in an aborted transaction to the pool. Fix: `client.release(true)` on the error path; wrap ROLLBACK in `.catch(()=>{})`.
- **L2** `router.ts:692-700` — per-conversation queue has no depth cap; a busy channel can queue N×(rate limit) full turns behind one serial chain, executing minutes later on a stale budget snapshot. Fix: shed with the rate-limit notice past a depth (~10).
- **L3** `textChunk.ts:11-16` — hard cut at `size` can split a surrogate pair (lone surrogate → `�` on Discord, body rejection on Meta). Fix: decrement `cut` by 1 if `charCodeAt(cut-1)` is a high surrogate.
- **L4** `discord/adapter.ts:745-765` (consumed `router.ts:1608-1631`) — if chunk *k* of *n* throws, ids of already-delivered chunks are lost: no retraction mapping, no outbound-interaction record (budget under-count), no `lastReply`. Fix: return the partial id list via a typed error.
- **L5** `index.ts:124-152` — `shutdown()` not idempotent (second signal double-ends the pool → unhandled rejection) and only the drain is time-bounded. Fix: `shuttingDown` guard + `Promise.race` deadline on the tail.
- **L6** `core.ts:704-707` — `resumeFailed = /session|resume/i.test(msg)` false-positives on any SDK error merely containing "session" (proxy/rate-limit text), discarding a healthy session and re-running the full turn. Fix: match a specific SDK error class/string.
- **L7** `router.ts:1024, 1047, 1091, 1586` — `pauseNotified`/`rateLimitNotified`/`budgetNotified`/`budgetWarned` are set *before* the `send().catch()`; a failed send yields silence *and* suppresses retry for the window (24 h for budget). Fix: latch only on send success.
- **L8** `tools.ts:2556-2559` (INFERRED impact) — `report_content` trusts a reporter-supplied `targetUserId` if `isKnownUser()`; naming a real admin as target hides the report from that admin's `list_reports`. Bounded by the super-admin backstop and rate cap. Fix (optional): require the target to be a participant of the report's conversation.
- **L9** `deploy/setup-ubuntu.sh:27, 46-54` — `curl -fsSL …nodesource… | bash -` as root (unpinned remote-code-as-root); `DB_USER`/`DB_NAME` interpolated unquoted into the `psql` heredoc (operator-controlled SQL surface). Fix: pinned `.deb` + verified GPG key; quote/validate identifiers.
- **L10** `deploy/community-agent.service` / `-redeploy.service` — good base hardening (`NoNewPrivileges`, `ProtectSystem=strict`, …) but missing cheap adds (`SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `CapabilityBoundingSet=`, `PrivateDevices`, `UMask=0077`); the redeploy unit runs as **root** with no hardening directives.
- **L11** `pipeline-pr-automerge.yml:178` — governance-path check reads `gh pr view --json files` (≤100-file API cap) and fails **open** on truncation, unlike the PR-list cap which warns. Fix: page the query or defer if the count hits the cap.
- **L12** `tsconfig.json` / `eslint.config.js` — `strict:true` and the async-safety rules are on, but the `@typescript-eslint/no-unsafe-*` family and `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` are off, removing the `any`-guard on untrusted chat/JSON flowing into RBAC and outbound logic. Deliberate per comments; consider ratcheting on `src/auth/` + outbound modules.
- **L13** `migrate.ts` + `schema.sql` — no migrations table; `migrate()` re-applies the whole `schema.sql` each run with 18 in-place `ALTER … IF NOT EXISTS`, so fresh-vs-upgraded parity rests on convention (some columns declared in both the CREATE and an ALTER), and migrations aren't run at app startup. Mitigated by CI running `migrate` + tests against real pgvector. Fix: a numbered `schema_migrations` table, or a CI diff of fresh-vs-upgraded schemas.
- **L14** god modules — `src/agent/tools.ts` 5,970 lines (`buildToolServer` ≈3,800 lines, 89 tools in one function), `repository.ts` 5,621 lines (153 exports, one flat module over ~25 tables), `router.ts` 1,728 lines; top 3 = 48% of `src/`. Drives the merge-conflict pain the pipeline docs already describe. Fix: split by tool group / table domain.
- **L15** duplication — the one-line debounce predicate is copy-pasted across 4 `*Notice.ts` files; the `mi`→`plain` i18n resolution ladder is re-inlined ~8× in `router.ts`; 53 test files each redefine `makeAdapter`, 27 redefine `makeMessage`, 116 repeat the token-bootstrap block, with no shared `tests/helpers`. Fix: a shared `notices.ts` (`shouldNotify`, `pickVariant`) and a `tests/helpers` module.

---

## 6. What's good (calibration)

1. **SQL is uniformly parameterized.** Across ~203 `pool.query` sites in `repository.ts`, every dynamic value uses positional `$N` placeholders; interpolation is confined to placeholder indices and static fragments (even interval strings are passed as parameters). No injection found. `npm audit` is clean (0 vulns) and git history carries no secrets.
2. **Layered, structural RBAC.** Roles derive only from env + `community_users` (never message content); the tool list is tier-computed so lower tiers never *see* higher tools; each privileged handler re-asserts tier; destructive actions are CONFIRM-gated and executed deterministically by the router with tier re-resolved at confirm time.
3. **Genuinely behavioral tests.** 140 test files (2.4× source), constructor-DI fakes rather than heavy module mocks, the *real* embedding pipeline exercised in router tests, and `repository.test.ts` run against a real `pgvector/pgvector:pg16` container in CI. The `SECURITY:`-tagged test discipline (760 tagged, manifest-pinned) is a real invariant, not decoration.
4. **Verified webhook and subprocess boundaries.** The Meta Cloud webhook verifies the HMAC with `timingSafeEqual` before parsing; Grok image-gen uses `spawn` with argv + a minimal env allowlist + a bubblewrap sandbox with a fail-closed self-check; bearer tokens stay in headers and out of thrown errors.
5. **Disciplined resource management.** Every in-memory map has a TTL sweep or size cap, all `pool.connect()` sites release in `finally`, background jobs are restart-safe via DB freshness stamps, and one job's failure can't kill its loop or the others.

---

## 7. Recommended sequence (first three actions, dependency order)

1. **Close the security-gate governance gap (H1).** Add `tests/security-floor.json` to the auto-merge governance-path regex and add `/tests/security-floor.json` + `/scripts/` to `CODEOWNERS`. This must land *first* and by human merge, because it is what protects every subsequent security-test change — including the ones the fixes below will add. (Pairs naturally with M7's `permissions:` block, a one-line CI change.)
2. **Fix the CONFIRM/escalation thread-keying bug (M1).** It silently breaks a shipped destructive-action flow; the fix is a small, localized change at two sites with a clear regression test (add a `SECURITY:` case for confirm-in-thread, bumping the floor entry under the H1 protection now in place).
3. **Close the two redaction/injection gaps together (M2 + M3).** Both are small, both touch the trusted-output boundary, and both want a new `SECURITY:` test — batching them makes one reviewable diff that hardens the DLP backstop and the CONFIRM-notice integrity in one pass.
