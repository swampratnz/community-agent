import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts (pulled in transitively via logger) validates env at import time —
// provide a dummy environment before importing anything that loads it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { loadChangelog, recentChanges } = await import('../src/agent/changelog.js');

test('loadChangelog parses top-level ## sections and ignores ### subsections', async () => {
  const sections = await loadChangelog();
  assert.ok(sections.length >= 2, 'expected at least two dated sections');
  for (const section of sections) {
    assert.ok(!section.heading.startsWith('#'), `heading should be stripped of #: "${section.heading}"`);
    assert.ok(section.body.length > 0, 'section body should not be empty');
  }
  // Subsection markers stay in the body, not promoted to their own sections.
  assert.ok(
    sections.some((s) => s.body.includes('### ')),
    'expected ### subsections inside a section body',
  );
});

test('recentChanges returns exactly the requested number of sections', async () => {
  const one = await recentChanges(1);
  assert.equal((one.match(/^## /gm) ?? []).length, 1);

  const two = await recentChanges(2);
  assert.equal((two.match(/^## /gm) ?? []).length, 2);
});

test('recentChanges clamps a huge limit to what exists and never throws on 0', async () => {
  const all = await loadChangelog();
  const huge = await recentChanges(999);
  assert.equal((huge.match(/^## /gm) ?? []).length, all.length);

  const zero = await recentChanges(0);
  assert.equal((zero.match(/^## /gm) ?? []).length, 1, 'a floor of 1 section is returned');
});
