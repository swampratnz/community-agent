import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCodePolicy,
  convertMarkdownForWhatsApp,
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

test("code policy 'off' with language 'mi' returns the te reo Māori note, not the English one (issue #339)", () => {
  const text = 'Here you go:\n```python\nprint("hi")\n```\nEnjoy!';
  const out = applyCodePolicy(text, 'off', 'mi');
  assert.ok(!out.includes('print("hi")'));
  assert.ok(!out.includes('code omitted'), 'must not fall back to the English note');
  assert.match(out, /whakakorehia te waehere/);
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

test("code policy 'snippets' with language 'mi' truncates and appends the te reo Māori note, not the English one (issue #339)", () => {
  const long = '```js\n' + Array.from({ length: 40 }, (_, i) => `line${i};`).join('\n') + '\n```';
  const out = applyCodePolicy(long, 'snippets', 'mi');
  assert.ok(out.includes('line0;'));
  assert.ok(out.includes('line14;'));
  assert.ok(!out.includes('line15;'));
  assert.ok(!out.includes('snippet truncated'), 'must not fall back to the English note');
  assert.match(out, /poroa te tauira ki 15 rārangi/);
});

test('SECURITY: applyCodePolicy/filterOutbound with no language argument (or anything other than "mi") is byte-identical to today (issue #339)', () => {
  const off = 'Here you go:\n```python\nprint("hi")\n```\nEnjoy!';
  const long = '```js\n' + Array.from({ length: 40 }, (_, i) => `line${i};`).join('\n') + '\n```';

  assert.equal(applyCodePolicy(off, 'off'), applyCodePolicy(off, 'off', undefined));
  assert.equal(applyCodePolicy(long, 'snippets'), applyCodePolicy(long, 'snippets', undefined));
  // Any non-'mi' value must never accidentally pick the Māori variant either.
  assert.equal(applyCodePolicy(off, 'off'), applyCodePolicy(off, 'off', 'en' as unknown as 'mi'));
  assert.equal(filterOutbound(off, 'off'), filterOutbound(off, 'off', [], 'discord', undefined));
});

test('SECURITY: an UNTERMINATED code fence cannot bypass the policy', () => {
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
  const out = filterOutbound('Token: sk-ant-api03-abcdefghijklmnop\n```js\nconsole.log(1)\n```', 'off');
  assert.ok(!out.includes('sk-ant-'));
  assert.match(out, /code omitted/);
});

test('convertMarkdownForWhatsApp: bold and headings and bullets', () => {
  const out = convertMarkdownForWhatsApp(
    '**bold** and __also bold__\n# Heading\n## Sub heading\n- one\n* two',
  );
  assert.match(out, /\*bold\* and \*also bold\*/);
  assert.match(out, /^\*Heading\*$/m);
  assert.match(out, /^\*Sub heading\*$/m);
  assert.match(out, /^• one$/m);
  assert.match(out, /^• two$/m);
});

test('convertMarkdownForWhatsApp: triple-emphasis and single-asterisk input degrade gracefully', () => {
  assert.equal(convertMarkdownForWhatsApp('***bold italic***'), '*bold italic*');
  assert.equal(convertMarkdownForWhatsApp('*already single*'), '*already single*');
});

test('convertMarkdownForWhatsApp: bullet/heading detection is line-anchored, inline * and # are untouched', () => {
  const text = 'price is 5 * 3 = 15, and a channel called #general';
  assert.equal(convertMarkdownForWhatsApp(text), text);
});

test('convertMarkdownForWhatsApp: is idempotent', () => {
  const text = '**bold**\n# Heading\n- item\n***triple***';
  const once = convertMarkdownForWhatsApp(text);
  const twice = convertMarkdownForWhatsApp(once);
  assert.equal(twice, once);
});

test('convertMarkdownForWhatsApp: fenced code blocks (including truncated-snippet notes) are never touched', () => {
  const long = '```js\n' + Array.from({ length: 40 }, (_, i) => `line${i};`).join('\n') + '\n```';
  const withNote = applyCodePolicy(long, 'snippets');
  const out = convertMarkdownForWhatsApp('**intro**\n' + withNote + '\n- outro');
  assert.match(out, /^\*intro\*$/m);
  assert.ok(out.includes('line0;'));
  assert.match(out, /^• outro$/m);
  // the italic truncation note (single underscores) must survive unmangled
  assert.match(out, /^_\[snippet truncated to 15 lines/m);
});

test('convertMarkdownForWhatsApp: prose + code fence mix keeps fence contents verbatim', () => {
  const text = '**Answer:**\n```js\nconst a = **not bold** here;\n```\n- done';
  const out = convertMarkdownForWhatsApp(text);
  assert.ok(out.includes('const a = **not bold** here;'), 'code fence body is untouched');
  assert.match(out, /^\*Answer:\*$/m);
  assert.match(out, /^• done$/m);
});

test('filterOutbound: Discord output (no platform arg) is byte-identical to pre-conversion behaviour', () => {
  const text = '**bold**\n# Heading\n- item';
  const withoutPlatform = filterOutbound(text, 'full');
  const withDiscord = filterOutbound(text, 'full', [], 'discord');
  const preConversion = stripEmDashesOutsideCode(applyCodePolicy(redactSecrets(text), 'full'));
  assert.equal(withoutPlatform, preConversion);
  assert.equal(withDiscord, preConversion);
});

test('filterOutbound: whatsapp platform applies markdown conversion after redaction/code policy/em-dash stripping', () => {
  const out = filterOutbound('**bold** — plain\n# Heading', 'full', [], 'whatsapp');
  assert.match(out, /^\*bold\*, plain$/m);
  assert.match(out, /^\*Heading\*$/m);
});

test("filterOutbound: threads its optional 5th 'language' parameter into applyCodePolicy exactly like the 4th 'platform' parameter threads into convertMarkdownForWhatsApp (issue #339)", () => {
  const out = filterOutbound('```js\nconsole.log(1)\n```', 'off', [], 'discord', 'mi');
  assert.match(out, /whakakorehia te waehere/);
  assert.ok(!out.includes('code omitted'));
});
