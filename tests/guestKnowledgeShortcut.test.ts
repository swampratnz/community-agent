import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../src/platforms/types.js';

// GUEST_KNOWLEDGE_SHORTCUT_ENABLED=true DB-integration tests (issue #165) —
// exercise the real searchKnowledge/recordAccessRequest/recordKnowledgeRetrieval
// paths against a real Postgres so the security-critical invariant is pinned
// end-to-end: a served guest shortcut reply never results in an `interactions`
// row, matching the existing gated-guest "content never stored" guarantee.
// This is the ONLY place GUEST_KNOWLEDGE_SHORTCUT_ENABLED is set to 'true' —
// router.test.ts leaves it unset so the default-off path stays covered
// untouched, mirroring knowledgeShortcutRouter.test.ts's convention.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.GUEST_KNOWLEDGE_SHORTCUT_ENABLED = 'true';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { config } = await import('../src/config.js');
const { pool, closeDb } = await import('../src/storage/db.js');

// Unique per test-run tag so fixtures never collide across runs, mirroring
// the RUN-tag convention in tests/knowledgeScope.test.ts.
const RUN = `gks${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const GLOBAL_CONTENT = `${RUN} global fact: guests can ask about membership pricing here`;
const CONV_SCOPED_CONTENT = `${RUN} conv-scope fact: standup is at 9am`;

const DIM = config.db.embeddingDim;
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[((i % DIM) + DIM) % DIM] = 1;
  return v;
}

// Hand-crafted, deterministic embeddings (no model download), same technique
// as tests/knowledgeScope.test.ts: each fixture string maps to its own
// orthogonal unit vector, so similarity is exactly 1 for an identical string.
const EMBED_FIXTURES: Record<string, number[]> = {
  [GLOBAL_CONTENT]: oneHot(101),
  [CONV_SCOPED_CONTENT]: oneHot(102),
};

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE content LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM interactions WHERE conversation_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM access_requests WHERE user_id LIKE $1`, [`${RUN}%`]);
  }
  await closeDb();
});

// node:test module mocking requires a TestContext (`t.mock`), but Router
// (imported transitively via repository's `embed`) must be mocked before any
// test dynamically imports it — install the mock via the first test's
// context and reuse the same imported bindings across the remaining tests,
// matching tests/knowledgeScope.test.ts's `repo(t)` helper.
let modsPromise: Promise<{
  Router: typeof import('../src/router.js').Router;
  saveKnowledge: typeof import('../src/storage/repository.js').saveKnowledge;
}> | null = null;
function mods(t: { mock: { module: (specifier: string, opts: unknown) => void } }) {
  if (!modsPromise) {
    t.mock.module('../src/storage/embeddings.js', {
      namedExports: {
        embed: async (text: string) => {
          const vec = EMBED_FIXTURES[text];
          if (!vec) {
            throw new Error(`guestKnowledgeShortcut test fixture: no hand-crafted vector for "${text}"`);
          }
          return vec;
        },
      },
    });
    modsPromise = (async () => {
      const { Router } = await import('../src/router.js');
      const { saveKnowledge } = await import('../src/storage/repository.js');
      return { Router, saveKnowledge };
    })();
  }
  return modsPromise;
}

function makeAdapter(): {
  adapter: PlatformAdapter;
  sent: OutgoingMessage[];
  trigger: (msg: IncomingMessage) => Promise<void>;
} {
  let handler: ((msg: IncomingMessage) => Promise<void> | void) | null = null;
  const sent: OutgoingMessage[] = [];
  const adapter: PlatformAdapter = {
    platform: 'discord',
    adminCapabilities: new Set(),
    async start() {},
    async stop() {},
    isConnected: () => true,
    onMessage(h) {
      handler = h;
    },
    async sendMessage(out) {
      sent.push(out);
    },
    async sendDirectMessage() {},
    async conversationsForUser() {
      return [];
    },
    async performAdminAction() {
      return '';
    },
  };
  return {
    adapter,
    sent,
    trigger: async (msg) => {
      if (!handler) throw new Error('router.register() was never called');
      await handler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    conversationId: `${RUN}-chan`,
    userId: `${RUN}-guest`,
    userName: 'A Guest',
    text: GLOBAL_CONTENT,
    isDirect: true,
    addressedToBot: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('config: GUEST_KNOWLEDGE_SHORTCUT_ENABLED=true is reflected in config.behaviour.guestKnowledgeShortcutEnabled', () => {
  assert.equal(config.behaviour.guestKnowledgeShortcutEnabled, true);
});

test(
  'SECURITY: a gated guest served a knowledge-shortcut reply gets no interactions row, but access_requests is still upserted (issue #165)',
  { skip },
  async (t) => {
    const { Router, saveKnowledge } = await mods(t);
    const { id } = await saveKnowledge({ content: GLOBAL_CONTENT, scope: 'global' });

    const router = new Router(async () => {
      throw new Error('runTurn must not be called for a gated guest');
    });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-guest`;
    await trigger(makeMessage({ userId }));

    assert.equal(sent.length, 1, 'the guest gets exactly one reply');
    assert.ok(sent[0].text.includes(GLOBAL_CONTENT), 'the reply carries the global knowledge entry content');
    assert.match(sent[0].text, /ask a community admin/i, 'the reply nudges toward getting added as a member');

    // Negative assertion: give any (wrong) fire-and-forget write ample time to land.
    await sleep(1_500);
    const { rows } = await pool.query(`SELECT 1 FROM interactions WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, 'SECURITY: a served guest shortcut reply must never be stored');

    const { rows: accessRows } = await pool.query(
      `SELECT request_count FROM access_requests WHERE user_id = $1`,
      [userId],
    );
    assert.equal(accessRows.length, 1, 'access_requests is still upserted regardless of the shortcut firing');

    const { rows: knowledgeRows } = await pool.query(`SELECT retrieval_count FROM knowledge WHERE id = $1`, [
      id,
    ]);
    assert.equal(
      Number(knowledgeRows[0].retrieval_count),
      1,
      'retrieval_count is bumped for the served entry, same as any other shortcut hit',
    );
  },
);

test(
  'SECURITY: a gated guest served by the knowledge shortcut gets a reply without the access-request record ' +
    'being awaited — the #480 non-blocking invariant holds on the shortcut-hit path even though issue #591 now ' +
    'awaits it on the static-notice-render path (issue #591)',
  { skip },
  async (t) => {
    const { Router, saveKnowledge } = await mods(t);
    await saveKnowledge({ content: GLOBAL_CONTENT, scope: 'global' });

    let recordConsumed = false;
    let resolveRecord: (() => void) | undefined;
    const hangingRecord = new Promise<{ inserted: boolean; firstRequestedAt: Date }>((resolve) => {
      resolveRecord = () => {
        recordConsumed = true;
        resolve({ inserted: true, firstRequestedAt: new Date() });
      };
    });

    const router = new Router(
      async () => {
        throw new Error('runTurn must not be called for a gated guest');
      },
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => hangingRecord, // recordAccessRequestFn: deliberately never resolves during this test
    );
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    const userId = `${RUN}-guest-shortcut-nonblocking`;
    await assert.doesNotReject(trigger(makeMessage({ userId })));

    assert.equal(sent.length, 1, 'the guest still gets the knowledge-shortcut reply');
    assert.ok(sent[0].text.includes(GLOBAL_CONTENT));
    assert.equal(
      recordConsumed,
      false,
      'the shortcut-hit path (no gated notice rendered) must never await the access-request record',
    );

    resolveRecord?.(); // avoid leaving a dangling unresolved promise past the end of the test
  },
);

test(
  'SECURITY: a gated guest never gets a conversation-scoped entry via the shortcut, even at very high similarity (issue #165)',
  { skip },
  async (t) => {
    const { Router, saveKnowledge } = await mods(t);
    const convScope = `${RUN}-conv-a`;
    await saveKnowledge({ content: CONV_SCOPED_CONTENT, scope: convScope });

    const router = new Router(async () => {
      throw new Error('runTurn must not be called for a gated guest');
    });
    const { adapter, sent, trigger } = makeAdapter();
    router.register(adapter);

    await trigger(
      makeMessage({
        userId: `${RUN}-guest-2`,
        conversationId: convScope,
        text: CONV_SCOPED_CONTENT,
      }),
    );

    assert.equal(sent.length, 1);
    assert.match(
      sent[0].text,
      /member-only/i,
      'a conversation-scoped entry must never be served to a guest — falls through to the static gated notice',
    );
  },
);
