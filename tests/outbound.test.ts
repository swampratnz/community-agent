import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCodePolicy, filterOutbound, redactSecrets } from '../src/agent/outbound.js';

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

test("code policy 'full' leaves code untouched", () => {
  const text = '```py\n' + 'x = 1\n'.repeat(50) + '```';
  assert.equal(applyCodePolicy(text, 'full'), text);
});

test('filterOutbound composes redaction and code policy', () => {
  const out = filterOutbound(
    'Token: sk-ant-api03-abcdefghijklmnop\n```js\nconsole.log(1)\n```',
    'off',
  );
  assert.ok(!out.includes('sk-ant-'));
  assert.match(out, /code omitted/);
});
