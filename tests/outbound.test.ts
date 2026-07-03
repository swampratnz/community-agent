import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCodePolicy,
  filterOutbound,
  redactSecrets,
  stripEmDashes,
  stripEmDashesOutsideCode,
} from '../src/agent/outbound.js';

test('SECURITY: known secret values are always redacted', () => {
  const secret = 'super-secret-oauth-token-value-123';
  const out = redactSecrets(`your token is ${secret}, keep it safe`, [secret]);
  assert.ok(!out.includes(secret));
  assert.match(out, /\[redacted\]/);
});

test('SECURITY: secret patterns are redacted', () => {
  const samples = [
    'sk-ant-api03-abcdefghijklmnop',
    'ghp_ABCDEFGHIJKLMNOPQRSTUV123456',
    'xoxb-1234567890-abcdefg',
    'AKIAIOSFODNN7EXAMPLE',
    'postgres://user:pass@host:5432/db',
  ];
  for (const s of samples) {
    const out = redactSecrets(`leak: ${s} end`);
    assert.ok(!out.includes(s), `must redact ${s}`);
  }
});

test("code policy 'off' removes code blocks entirely", () => {
  const text = 'Here you go:\n```python\nprint("hi")\n```\nEnjoy!';
  const out = applyCodePolicy(text, 'off');
  assert.ok(!out.includes('print("hi")'));
  assert.match(out, /code omitted/);
  assert.match(out, /Enjoy!/);
});

test("code policy 'snippets' keeps short blocks, truncates long ones", () => {
  const short = '```js\n' + 'x;\n'.repeat(5) + '```';
  assert.equal(applyCodePolicy(short, 'snippets'), short);

  const long = '```js\n' + Array.from({ length: 40 }, (_, i) => `line${i};`).join('\n') + '\n```';
  const out = applyCodePolicy(long, 'snippets');
  assert.ok(out.includes('line0;'));
  assert.ok(out.includes('line14;'));
  assert.ok(!out.includes('line15;'));
  assert.match(out, /snippet truncated/);
});

test("SECURITY: an UNTERMINATED code fence cannot bypass the policy", () => {
  // A sweet-talked model (or a cut-off reply) can open a fence and never
  // close it; the policy must treat it as running to end-of-text.
  const sneaky = 'Sure!\n```python\n' + Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const off = applyCodePolicy(sneaky, 'off');
  assert.ok(!off.includes('line0'), "'off' must strip an unterminated fence");
  assert.match(off, /code omitted/);

  const snip = applyCodePolicy(sneaky, 'snippets');
  assert.ok(snip.includes('line14'));
  assert.ok(!snip.includes('line15'), "'snippets' must truncate an unterminated fence");
  assert.match(snip, /snippet truncated/);
});

test("code policy 'full' leaves code untouched", () => {
  const text = '```py\n' + 'x = 1\n'.repeat(50) + '```';
  assert.equal(applyCodePolicy(text, 'full'), text);
});

test('stripEmDashes rewrites em dashes to natural punctuation', () => {
  assert.equal(stripEmDashes('it works — mostly'), 'it works, mostly');
  assert.equal(stripEmDashes('works—mostly'), 'works, mostly');
  assert.equal(stripEmDashes('done — .'), 'done.');
  // en dash ranges are left intact
  assert.equal(stripEmDashes('lines 10–20'), 'lines 10–20');
  // plain hyphens are untouched
  assert.equal(stripEmDashes('opt-in flag'), 'opt-in flag');
});

test('em dashes inside code fences are left alone, prose is cleaned', () => {
  const text = 'Kia ora — welcome!\n```js\nconst a = 1 — 2\n```\nlater — bye';
  const out = stripEmDashesOutsideCode(text);
  assert.ok(!out.split('```')[0].includes('—'), 'prose before the fence is cleaned');
  assert.ok(out.includes('const a = 1 — 2'), 'code inside the fence is untouched');
  assert.ok(!out.split('```')[2].includes('—'), 'prose after the fence is cleaned');
});

test('filterOutbound strips em dashes end-to-end', () => {
  const out = filterOutbound('Sweet as — all sorted', 'full');
  assert.ok(!out.includes('—'));
  assert.match(out, /Sweet as, all sorted/);
});

test('filterOutbound composes redaction and code policy', () => {
  const out = filterOutbound(
    'Token: sk-ant-api03-abcdefghijklmnop\n```js\nconsole.log(1)\n```',
    'off',
  );
  assert.ok(!out.includes('sk-ant-'));
  assert.match(out, /code omitted/);
});
