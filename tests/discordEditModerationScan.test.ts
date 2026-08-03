import { test } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { DISCORD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import { Events } from 'discord.js';

// Issue #798: before this fix, `onMessageUpdate` never called
// `Moderator.scan()` at all, so a member could post clean text and then edit
// in abuse completely undetected — no `member_warnings` row, no `mod-alerts`,
// no strike. This file pins the fix at the REAL gateway-listener level (not
// just the private method), because the registration gate for the
// MessageUpdate listener itself was also missing `config.moderation.enabled`
// — a deployment with moderation on but neither `DISCORD_ARCHIVE_ALL_MESSAGES`
// nor `AUTO_RETRACT_REPLY_ENABLED` (the common case: an operator who wants
// abuse detection, not full ambient archiving) would otherwise never wire the
// listener up, silently reopening the exact bypass this issue closes. Lives
// in its own file/process because config.ts parses env once at import
// (mirrors tests/replyRetractionDisabled.test.ts's flag-split convention).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= 'guild-798';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.DISCORD_MODERATION_ENABLED = 'true';

const { config } = await import('../src/config.js');
const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');

assert.equal(config.moderation.enabled, true, 'DISCORD_MODERATION_ENABLED must be on for this file');
assert.equal(
  config.discord.archiveAllMessages,
  false,
  'DISCORD_ARCHIVE_ALL_MESSAGES must stay unset for this file — the point is proving the MessageUpdate ' +
    'listener is wired from moderation alone, not from archiving',
);
assert.equal(
  config.behaviour.autoRetractReplyEnabled,
  false,
  'AUTO_RETRACT_REPLY_ENABLED must stay unset for this file, same reason',
);

type Adapter = InstanceType<typeof DiscordAdapter>;
type ScannedContext = { text: string; userId: string; channelId: string };

function guildMessage(opts: { authorId: string; content: string; bot?: boolean; partial?: boolean }) {
  return {
    author: { id: opts.authorId, bot: opts.bot ?? false, username: 'Tester' },
    member: { displayName: 'Tester' },
    content: opts.content,
    channelId: 'chan-798',
    channel: { isThread: () => false },
    guildId: config.discord.guildId,
    id: 'msg-798',
    partial: opts.partial ?? false,
  };
}

function dmMessage(opts: { authorId: string; content: string }) {
  return { ...guildMessage(opts), guildId: null };
}

/** Boots the adapter's real gateway listeners (login stubbed) with moderator.scan mocked. */
async function startAdapterWithScanSpy(): Promise<{
  client: { emit: (event: string, ...args: unknown[]) => void };
  scanned: ScannedContext[];
}> {
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  adapter.onMessage(async () => {});
  const scanned: ScannedContext[] = [];
  (adapter as unknown as { moderator: { scan: (ctx: ScannedContext) => Promise<void> } }).moderator.scan =
    async (ctx) => {
      scanned.push(ctx);
    };
  const client = (
    adapter as unknown as {
      client: { emit: (event: string, ...args: unknown[]) => void; login: (t: string) => Promise<void> };
    }
  ).client;
  client.login = async () => {};
  await adapter.start();
  return { client, scanned };
}

test(
  'SECURITY: DISCORD_MODERATION_ENABLED alone (archiving + retraction both off) registers the ' +
    'MessageUpdate listener and reaches Moderator.scan() exactly once on an edited guild message ' +
    '(issue #798)',
  async () => {
    const { client, scanned } = await startAdapterWithScanSpy();
    const oldMsg = guildMessage({ authorId: 'user-1', content: 'clean text' });
    const newMsg = guildMessage({ authorId: 'user-1', content: 'clean text turned abusive' });
    client.emit(Events.MessageUpdate, oldMsg, newMsg);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scanned.length, 1, 'an edit with changed content must reach Moderator.scan() exactly once');
    assert.equal(scanned[0].text, 'clean text turned abusive');
    assert.equal(scanned[0].userId, 'user-1');
    assert.equal(scanned[0].channelId, 'chan-798');
  },
);

test('SECURITY: a MessageUpdate with unchanged content never reaches Moderator.scan() a second time (issue #798)', async () => {
  const { client, scanned } = await startAdapterWithScanSpy();
  const oldMsg = guildMessage({ authorId: 'user-2', content: 'same text' });
  const newMsg = guildMessage({ authorId: 'user-2', content: 'same text' });
  client.emit(Events.MessageUpdate, oldMsg, newMsg);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    scanned.length,
    0,
    'unchanged content (e.g. an embed unfurl or pin-state change) must not trigger a re-scan',
  );
});

test(
  'a MessageUpdate whose pre-edit message is partial/uncached (content diff impossible) still reaches ' +
    'Moderator.scan() — fails toward detection, never toward silence (issue #798)',
  async () => {
    const { client, scanned } = await startAdapterWithScanSpy();
    const oldMsg = guildMessage({ authorId: 'user-3', content: '', partial: true });
    const newMsg = guildMessage({ authorId: 'user-3', content: 'unknowable prior content' });
    client.emit(Events.MessageUpdate, oldMsg, newMsg);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scanned.length, 1, 'an unresolvable pre-edit diff must fail toward scanning');
  },
);

test('SECURITY: DMs and bot-authored edits never reach Moderator.scan() (issue #798)', async () => {
  const { client, scanned } = await startAdapterWithScanSpy();

  const botOld = guildMessage({ authorId: 'bot-1', content: 'x', bot: true });
  const botNew = guildMessage({ authorId: 'bot-1', content: 'y', bot: true });
  client.emit(Events.MessageUpdate, botOld, botNew);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scanned.length, 0, 'a bot-authored edit must never be scanned');

  const dmOld = dmMessage({ authorId: 'user-4', content: 'x' });
  const dmNew = dmMessage({ authorId: 'user-4', content: 'y' });
  client.emit(Events.MessageUpdate, dmOld, dmNew);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scanned.length, 0, 'a DM edit must never be scanned — muting is a guild concept');
});
