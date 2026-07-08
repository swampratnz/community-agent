import { test } from 'node:test';
import assert from 'node:assert/strict';

// grokImage.ts imports config.ts, which validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { sniffImageType, parseSessionId, buildGrokArgs, grokEnv } = await import('../src/media/grokImage.js');

test('sniffImageType detects JPEG / PNG / WebP from magic bytes', () => {
  assert.deepEqual(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {
    mimeType: 'image/jpeg',
    ext: 'jpg',
  });
  assert.deepEqual(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), {
    mimeType: 'image/png',
    ext: 'png',
  });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.deepEqual(sniffImageType(webp), { mimeType: 'image/webp', ext: 'webp' });
});

test('sniffImageType returns null for non-image or empty bytes (never mislabels)', () => {
  assert.equal(sniffImageType(Buffer.from('this is not an image, it is an error message')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  // A near-miss that shares no full signature must not be treated as an image.
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0x00])), null);
});

test('SECURITY: buildGrokArgs runs grok kernel-sandboxed (strict) with no --always-approve and no --tools', () => {
  const args = buildGrokArgs('/imagine draw a cat');
  // KERNEL sandbox is the real containment: it blocks the agent from reading the
  // bot's secrets (`.env`, `~/.grok/auth.json`) or exfiltrating, regardless of
  // which tools are auto-approved. `--sandbox` must be immediately followed by
  // exactly `strict` (workspace/read-only would let it read the whole FS).
  const s = args.indexOf('--sandbox');
  assert.ok(s >= 0, '--sandbox must be present');
  assert.equal(args[s + 1], 'strict', 'the sandbox profile must be strict');
  // NO --always-approve: headless grok then cancels approval-gated tools (shell,
  // file write) instead of running them. Re-adding it would reopen that surface.
  assert.ok(!args.includes('--always-approve'), '--always-approve must never be passed');
  // No --tools allowlist (the image tool is not --tools-selectable; an allowlist
  // referencing a non-existent tool breaks grok's agent build).
  assert.ok(!args.includes('--tools'), 'a --tools allowlist must not be used');
  assert.ok(args.includes('--disable-web-search'), 'web tools must be disabled');
  // The free-text prompt is the value of -p, an argv element (never a shell string).
  const p = args.indexOf('-p');
  assert.ok(p >= 0);
  assert.equal(args[p + 1], '/imagine draw a cat');
});

test('SECURITY: grokEnv hands the subprocess a secret-free allowlist, never the bot env', () => {
  // Plant a representative secret from every family the bot holds. grok is a
  // third-party agentic CLI; inheriting any of these would leak them to it.
  const secrets = {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-should-not-leak',
    DISCORD_BOT_TOKEN: 'discord-should-not-leak',
    DATABASE_URL: 'postgres://should:not@leak/db',
    WHATSAPP_APP_SECRET: 'wa-should-not-leak',
    XAI_API_KEY: 'xai-should-not-leak',
    SOME_OTHER_TOKEN: 'random-should-not-leak',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(secrets)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // A pass-through knob and an unrelated var, to pin the allowlist's shape.
  const savedGrok = process.env.GROK_SANDBOX;
  const savedFoo = process.env.SHOULD_NOT_PASS_THROUGH;
  process.env.GROK_SANDBOX = 'on';
  process.env.SHOULD_NOT_PASS_THROUGH = 'nope';

  try {
    const env = grokEnv();
    // No secret value appears anywhere in the handed-down env.
    const values = Object.values(env).join(' ');
    for (const v of Object.values(secrets)) {
      assert.ok(!values.includes(v), `secret value must not reach grok: ${v}`);
    }
    // And none of the secret KEYS are present either.
    for (const k of Object.keys(secrets)) {
      assert.ok(!(k in env), `secret key must not reach grok: ${k}`);
    }
    // Only the curated, non-secret vars pass through.
    assert.equal(env.TERM, 'dumb');
    assert.equal(env.PATH, process.env.PATH, 'PATH is allowed (locate the binary)');
    assert.equal(env.GROK_SANDBOX, 'on', "grok's own GROK_-prefixed knobs pass through");
    assert.ok(!('SHOULD_NOT_PASS_THROUGH' in env), 'an arbitrary non-GROK_/XDG_ var does not pass through');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedGrok === undefined) delete process.env.GROK_SANDBOX;
    else process.env.GROK_SANDBOX = savedGrok;
    if (savedFoo === undefined) delete process.env.SHOULD_NOT_PASS_THROUGH;
    else process.env.SHOULD_NOT_PASS_THROUGH = savedFoo;
  }
});

test('parseSessionId reads the session id from grok JSON stdout', () => {
  const sid = '019f33c3-4797-74c0-8d0e-cab1413edcb7';
  assert.equal(parseSessionId(JSON.stringify({ text: 'done', sessionId: sid })), sid);
  // Regex fallback when stdout is not clean JSON (e.g. a stray log line prefix).
  assert.equal(parseSessionId(`warn: something\n{"sessionId":"${sid}","stopReason":"EndTurn"}`), sid);
});

test('parseSessionId returns null when no valid session id is present', () => {
  assert.equal(parseSessionId('{"text":"no id here"}'), null);
  assert.equal(parseSessionId('not json at all'), null);
  // A malformed id (wrong shape) is not accepted.
  assert.equal(parseSessionId('{"sessionId":"nope"}'), null);
});
