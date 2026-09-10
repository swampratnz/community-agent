/**
 * Maintainer-run, off-CI answer-quality eval harness (issue #779,
 * `docs/CAPABILITY-IDEAS.md` §F1).
 *
 * `tests/knowledgeEval.test.ts` (issue #62) proves `knowledge_search`
 * *retrieval* precision@K against a curated query set — this proves the
 * other half: that the model turns a retrieved entry into a correctly
 * grounded reply. It calls the real pipeline, `runAgentTurn`
 * (`@swampratnz/agent-base/agent/core.js`), through a stub `PlatformAdapter` whose `sendMessage` just
 * captures text instead of hitting Discord/WhatsApp, so it exercises the
 * actual system-prompt/tool-selection pipeline a member's message goes
 * through, not a shortcut. Each fixture entry is graded deterministically —
 * `mustContain`/`mustNotContain` fact fragments, plus `expectedCitedUrl`
 * (checked via `checkCitedUrls`) — mirroring promptfoo's `contains`/
 * `not-contains` asserts, so running this costs no extra spend beyond the
 * turns themselves.
 *
 * Same off-CI posture as docs/RED-TEAM.md's sweep, for the same reasons: a
 * real model call per fixture entry on the maintainer's own Max-pool
 * credential, never in a workflow, never wired into `npm test` or
 * `npm run test:security` (enforced by tests/evalAnswersOffCi.test.ts, not
 * just this comment).
 *
 * Usage: `npm run eval:answers` — needs a real `CLAUDE_CODE_OAUTH_TOKEN`
 * and a reachable `DATABASE_URL` (same requirements as running the bot
 * itself); degrades to a clean skip, not a crash, when either is absent,
 * matching this repo's DB-test convention (see CLAUDE.md).
 *
 * The harness execution (env guards, DB/model calls, `process.exit`) is
 * guarded behind `invokedDirectly` below, so `checkCitedUrls` — the pure
 * citation-URL grading function — can be imported by
 * tests/evalAnswersCitationCheck.test.ts and unit-tested in normal `npm
 * test`/CI without pulling in a DB connection or a model call.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface FixtureCase {
  question: string;
  mustContain: string[];
  mustNotContain: string[];
  expectedCitedUrl?: string;
}

// Bounded, mirrors the existing lowercase-substring matching style used for
// mustContain/mustNotContain. Trailing sentence punctuation is stripped so a
// URL at the end of a sentence isn't spuriously mismatched against the exact
// expectedCitedUrl.
const URL_PATTERN = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:)\]}]+$/;

/**
 * Extracts every URL substring from `replyText` and returns the ones that
 * are NOT grounded: when `expectedCitedUrl` is set, any URL that doesn't
 * exactly equal it; when `expectedCitedUrl` is undefined, every URL found
 * (nothing legitimate to cite, so any URL is by definition invented,
 * guessed, normalized, or lifted from a content body).
 */
export function checkCitedUrls(replyText: string, expectedCitedUrl: string | undefined): string[] {
  const urls = (replyText.match(URL_PATTERN) ?? []).map((url) =>
    url.replace(TRAILING_PUNCTUATION_PATTERN, ''),
  );
  return expectedCitedUrl === undefined ? urls : urls.filter((url) => url !== expectedCitedUrl);
}

// Guarded so this module can be imported by tests without running the
// harness. `pathToFileURL` (not a hand-built `file://` string) so this
// comparison is correct on Windows too, mirroring scripts/handoff-note.mjs.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (!process.env.DATABASE_URL) {
    console.log(
      'eval-answers: DATABASE_URL not set — skipping (needs a local Postgres + pgvector to seed the fixture ' +
        'knowledge entries; see CLAUDE.md).',
    );
    process.exit(0);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log(
      'eval-answers: CLAUDE_CODE_OAUTH_TOKEN not set — skipping (this harness calls the real model on your own ' +
        'credential; run `claude setup-token` first).',
    );
    process.exit(0);
  }

  const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
  const { saveKnowledge } = await import('@swampratnz/agent-base/storage/repository.js');
  const { runAgentTurn } = await import('@swampratnz/agent-base/agent/core.js');
  type CallerContextType = import('@swampratnz/agent-base/auth/rbac.js').CallerContext;
  type PlatformAdapterType = import('@swampratnz/agent-base/platforms/types.js').PlatformAdapter;
  type OutgoingMessageType = import('@swampratnz/agent-base/platforms/types.js').OutgoingMessage;
  type KnowledgeCreatedByRole = Parameters<typeof saveKnowledge>[0]['createdByRole'];

  interface FixtureKnowledgeEntry {
    title: string;
    content: string;
    sourceUrl?: string;
    sourceTitle?: string;
    createdByRole?: KnowledgeCreatedByRole;
  }

  interface Fixture {
    knowledgeEntries: FixtureKnowledgeEntry[];
    cases: FixtureCase[];
  }

  interface CaseResult {
    question: string;
    reply: string;
    missingContain: string[];
    presentForbidden: string[];
    unexpectedUrls: string[];
  }

  const fixturePath = fileURLToPath(new URL('../tests/fixtures/answersEval.json', import.meta.url));
  const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  // Unique per-run scope so fixture rows never collide across runs and are
  // cleaned up precisely, mirroring the EVAL_SCOPE convention in
  // tests/knowledgeEval.test.ts.
  const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const EVAL_SCOPE = `${RUN}-answers-eval`;

  const captured: string[] = [];

  // A stub adapter: sendMessage/sendDirectMessage/performAdminAction just
  // capture or no-op rather than reaching Discord/WhatsApp, so a turn that
  // happens to call an admin-facing tool doesn't crash the harness or touch a
  // real platform. The graded reply always comes from runAgentTurn's own
  // return value (AgentReply.text), never from what's captured here.
  const stubAdapter: PlatformAdapterType = {
    platform: 'discord',
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage: () => {},
    async sendMessage(out: OutgoingMessageType) {
      captured.push(out.text);
      return undefined;
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [EVAL_SCOPE];
    },
    adminCapabilities: new Set<string>(),
    async performAdminAction() {
      return 'eval-answers: admin actions are not supported by the stub adapter';
    },
  };

  const caller: CallerContextType = {
    platform: 'discord',
    userId: 'eval-answers-harness',
    userName: 'Eval Harness',
    role: 'member',
    conversationId: EVAL_SCOPE,
    isDirect: false,
  };

  const main = async (): Promise<number> => {
    for (const entry of fixture.knowledgeEntries) {
      await saveKnowledge({
        title: entry.title,
        content: entry.content,
        scope: EVAL_SCOPE,
        sourceUrl: entry.sourceUrl,
        sourceTitle: entry.sourceTitle,
        createdByRole: entry.createdByRole,
      });
    }

    const results: CaseResult[] = [];
    for (const c of fixture.cases) {
      const reply = await runAgentTurn(caller, c.question, stubAdapter);
      const text = reply.text ?? '';
      const lowerText = text.toLowerCase();
      const missingContain = c.mustContain.filter((frag) => !lowerText.includes(frag.toLowerCase()));
      const presentForbidden = c.mustNotContain.filter((frag) => lowerText.includes(frag.toLowerCase()));
      const unexpectedUrls = checkCitedUrls(text, c.expectedCitedUrl);
      results.push({ question: c.question, reply: text, missingContain, presentForbidden, unexpectedUrls });
    }

    let failures = 0;
    for (const r of results) {
      const failed =
        r.missingContain.length > 0 || r.presentForbidden.length > 0 || r.unexpectedUrls.length > 0;
      if (failed) failures += 1;
      console.log(`${failed ? 'FAIL' : 'PASS'}  ${r.question}`);
      if (failed) {
        if (r.missingContain.length > 0) console.log(`  missing: ${JSON.stringify(r.missingContain)}`);
        if (r.presentForbidden.length > 0)
          console.log(`  forbidden present: ${JSON.stringify(r.presentForbidden)}`);
        if (r.unexpectedUrls.length > 0)
          console.log(`  unexpected URLs: ${JSON.stringify(r.unexpectedUrls)}`);
        console.log(`  reply: ${r.reply}`);
      }
    }

    console.log(`\neval-answers: ${results.length - failures}/${results.length} passed.`);
    return failures;
  };

  let exitCode: number;
  try {
    exitCode = (await main()) > 0 ? 1 : 0;
  } finally {
    await pool.query('DELETE FROM knowledge WHERE scope = $1', [EVAL_SCOPE]);
    await closeDb();
  }
  process.exit(exitCode);
}
