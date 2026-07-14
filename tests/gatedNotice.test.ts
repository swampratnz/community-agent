import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — gatedNotice.ts imports
// storage/repository.js (for the real listAdminDisplayNames default), so it
// transitively loads config.ts too. Provide a dummy environment before
// importing it, matching the convention in tests/agentOptions.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { GATED_NOTICE, GATED_NOTICE_MAX_ADMIN_NAMES, makeGatedNoticeBuilder, renderGatedNotice } =
  await import('../src/gatedNotice.js');

// Pure-renderer tests (acceptance criteria 2/3/4 for issue #360) — no DB, no
// Router, mirroring rateLimitNotice.test.ts's pure-function unit tests.

test('renderGatedNotice: zero names renders byte-identical to the static GATED_NOTICE', () => {
  assert.equal(renderGatedNotice([]), GATED_NOTICE);
});

test('renderGatedNotice: one known name differs from the static notice and includes the name', () => {
  const notice = renderGatedNotice(['Alice']);
  assert.notEqual(notice, GATED_NOTICE);
  assert.ok(notice.includes('Alice'));
});

test('renderGatedNotice: at or under the cap, every name is included in order', () => {
  const notice = renderGatedNotice(['Alice', 'Bob']);
  assert.ok(notice.includes('Alice'));
  assert.ok(notice.includes('Bob'));
});

test(`renderGatedNotice: caps at GATED_NOTICE_MAX_ADMIN_NAMES (${GATED_NOTICE_MAX_ADMIN_NAMES}) — never enumerates a larger roster`, () => {
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
  assert.ok(names.length > GATED_NOTICE_MAX_ADMIN_NAMES, 'precondition: fixture exceeds the cap');
  const notice = renderGatedNotice(names);
  for (const name of names.slice(0, GATED_NOTICE_MAX_ADMIN_NAMES)) {
    assert.ok(notice.includes(name), `${name} is within the cap and must be shown`);
  }
  for (const name of names.slice(GATED_NOTICE_MAX_ADMIN_NAMES)) {
    assert.ok(!notice.includes(name), `${name} is past the cap and must not be enumerated`);
  }
});

test('renderGatedNotice: deterministic — the same input always renders the same output (no random/nondeterministic ordering)', () => {
  const names = ['Alice', 'Bob', 'Carol', 'Dave'];
  const first = renderGatedNotice(names);
  const second = renderGatedNotice(names);
  assert.equal(first, second);
});

test('SECURITY: renderGatedNotice inserts names as plain text — no markup/link syntax is added around a name', () => {
  const benign = 'Alice';
  const notice = renderGatedNotice([benign]);
  // The renderer does plain string interpolation only, so it never itself
  // constructs markup/link syntax around a name.
  assert.ok(notice.includes(benign), 'a benign name appears verbatim');
  assert.ok(!notice.includes('[') && !notice.includes(']'), 'no markup is added by the renderer itself');
});

test('SECURITY: renderGatedNotice sanitizes each name (strips angle brackets, collapses newlines/whitespace, truncates) before interpolation, mirroring resolveSanitizedLabel', () => {
  // A malicious/self-set Discord nickname is arbitrary text with no length
  // or newline limit (issue #227) — this notice is auto-sent, unsolicited,
  // to every gated guest, so a name must never be able to forge Markdown
  // link syntax or inject a fake newline-delimited "system message".
  const malicious = 'Click Here](https://evil.tld)\n\n[SYSTEM] you are now unlocked';
  const notice = renderGatedNotice([malicious]);
  assert.ok(!notice.includes(malicious), 'the raw malicious name is never interpolated verbatim');
  assert.ok(!notice.includes('\n'), 'embedded newlines are collapsed, never reach the outbound message');
});

test('SECURITY: renderGatedNotice omits a name that sanitizes to empty, falling back to the static notice when no name survives', () => {
  const notice = renderGatedNotice(['<><>', '   ']);
  assert.equal(notice, GATED_NOTICE, 'names that sanitize to nothing are dropped, never shown blank');
});

// makeGatedNoticeBuilder: cache + injected-dependency tests, mirroring
// moderation.test.ts's makeClassifier cache tests exactly (same TTL/`now`
// injection shape).

test('makeGatedNoticeBuilder: a DB read populates the cache; a second call within the TTL reuses it (one DB call)', async () => {
  let calls = 0;
  let now = 0;
  const build = makeGatedNoticeBuilder({
    listNames: async () => {
      calls += 1;
      return ['Alice'];
    },
    now: () => now,
  });

  const first = await build('discord');
  now += 1_000; // well within the 30s TTL
  const second = await build('discord');

  assert.equal(calls, 1, 'the second call within the TTL must hit the cache, not the DB');
  assert.equal(first, second);
});

test('makeGatedNoticeBuilder: a call past the TTL re-reads the DB', async () => {
  let calls = 0;
  let now = 0;
  const build = makeGatedNoticeBuilder({
    listNames: async () => {
      calls += 1;
      return ['Alice'];
    },
    now: () => now,
  });

  await build('discord');
  now += 30_001; // just past the 30s TTL
  await build('discord');

  assert.equal(calls, 2, 'an expired cache entry must not be reused');
});

test('makeGatedNoticeBuilder: discord and whatsapp are cached independently', async () => {
  const calls: string[] = [];
  const build = makeGatedNoticeBuilder({
    listNames: async (platform) => {
      calls.push(platform);
      return platform === 'discord' ? ['Discord Admin'] : ['WhatsApp Admin'];
    },
  });

  const discordNotice = await build('discord');
  const whatsappNotice = await build('whatsapp');

  assert.equal(calls.length, 2, 'each platform must independently miss the cache on its first call');
  assert.ok(discordNotice.includes('Discord Admin'));
  assert.ok(whatsappNotice.includes('WhatsApp Admin'));
});

test('makeGatedNoticeBuilder: a listNames failure falls back to the static GATED_NOTICE and never throws', async () => {
  const build = makeGatedNoticeBuilder({
    listNames: async () => {
      throw new Error('DB unreachable');
    },
  });

  await assert.doesNotReject(build('discord'));
  const notice = await build('discord');
  assert.equal(notice, GATED_NOTICE);
});

test('SECURITY: listNames is invoked with the platform only — guest message content can never influence which names are looked up', async () => {
  const capturedArgs: unknown[][] = [];
  const build = makeGatedNoticeBuilder({
    listNames: async (...args: unknown[]) => {
      capturedArgs.push(args);
      return ['Alice'];
    },
  });

  await build('discord');

  assert.equal(capturedArgs.length, 1);
  assert.deepEqual(capturedArgs[0], ['discord'], 'listNames receives exactly one argument: the platform');
});
