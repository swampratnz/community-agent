import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
// The default bad-word list is community content registered at its own module
// scope (src/index.ts imports it in production); the moderation wordlist fails
// closed until then, and constructing a Discord adapter builds a Moderator.
import '../src/moderation/badWords.js';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/platforms/factories.ts, so these constructions pass the same pack.
import { DISCORD_TEXT_PACK } from '../src/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/strings/notices.js';
import { Events, MessageFlags } from 'discord.js';

// config.ts validates env at import time (see tests/discordAdapter.test.ts for
// the same rationale) — DATABASE_URL points nowhere; every DB read below is
// mocked on `pool.query` per test, no real Postgres required.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= 'guild-1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { DiscordAdapter } = await import('../src/platforms/discord/adapter.js');
const { config } = await import('../src/config.js');
const { pool } = await import('../src/storage/db.js');
const { resetPolicyCacheForTests } = await import('../src/storage/policyStore.js');
// The registration/dispatch mechanism is base (slashDispatch.ts); importing
// the community command module binds its Discord halves onto the registry.
await import('../src/platforms/discord/slashCommands.js');
const { handleInteraction, buildSlashCommands, registerSlashCommands } =
  await import('../src/platforms/discord/slashDispatch.js');
const { buildMemberDigestContent } = await import('../src/memberDigest.js');
const { logger } = await import('../src/logger.js');
const { KNOWLEDGE_CONFLICT_CAVEAT_TEXT, KNOWLEDGE_LOW_RATED_CAVEAT_TEXT } =
  await import('../src/agent/tools.js');
// Both caveat constants contain an em dash, and every /kb reply passes through
// deps.filtered() (the same outbound pipeline as every other send path, per
// this file's own criterion 6/13 test) — which rewrites em dashes into a
// comma (stripEmDashes in outbound.ts) before the text ever reaches Discord.
// So the caveat as actually delivered is this rewritten form, not the raw
// exported constant.
const { stripEmDashes } = await import('../src/agent/outbound.js');

type Adapter = InstanceType<typeof DiscordAdapter>;

/** Mutable view of the flag this whole file toggles, restored by each test. */
function slashFlag(): { slashCommandsEnabled: boolean } {
  return config.discord;
}

interface PoolRow {
  [key: string]: unknown;
}

/**
 * Stubs `pool.query` for every DB read a slash command can trigger, branching
 * on a recognisable substring of the SQL text — same convention every other
 * test file in this suite uses (see stubConversationsGuild in
 * discordAdapter.test.ts), since `pool` is a plain object whose `query`
 * method is safely mockable, unlike the ES-module function exports the
 * repository layer wraps around it.
 */
function mockPool(
  t: TestContext,
  opts: {
    memberRole?: 'admin' | 'member' | null;
    knowledgeRows?: PoolRow[];
    interestRows?: PoolRow[];
    /** listRecentInterests' browse-all rows (issue #920) — distinct from `interestRows` (the search/self-match rows), since both queries hit `member_interests`. */
    recentInterestRows?: PoolRow[];
    projectRows?: PoolRow[];
    guidelines?: string | null;
    guidelinesMi?: string | null;
    languagePref?: 'en' | 'mi';
    /** `hasConflictAmongIds`'s verdict — `undefined` means the query is never expected to run. */
    conflictExists?: boolean;
    /** `areKnowledgeEntriesLowRated`'s returned id set, as raw rows. */
    lowRatedIds?: number[];
  } = {},
): Array<{ sql: string; params: unknown[] }> {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: opts.memberRole ? [{ role: opts.memberRole }] : [], rowCount: 0 };
    }
    // hasConflictAmongIds's self-join ("...FROM knowledge a JOIN knowledge b...")
    // and areKnowledgeEntriesLowRated's join ("FROM answer_feedback JOIN ...
    // JOIN knowledge ...") both contain the generic 'FROM knowledge' substring
    // the plain searchKnowledge branch below matches on, so both are matched
    // on a more specific substring FIRST.
    if (sql.includes('JOIN knowledge b')) {
      return { rows: opts.conflictExists ? [{ '?column?': 1 }] : [], rowCount: 0 };
    }
    if (sql.includes('FROM answer_feedback')) {
      return { rows: (opts.lowRatedIds ?? []).map((id) => ({ id })), rowCount: 0 };
    }
    if (sql.includes('FROM knowledge')) {
      return { rows: opts.knowledgeRows ?? [], rowCount: 0 };
    }
    // listRecentInterests' plain browse query (issue #920) matched FIRST on
    // its distinguishing `ORDER BY updated_at DESC` — self-match/search
    // queries order by embedding distance instead, so this never shadows them.
    if (sql.includes('FROM member_interests') && sql.includes('ORDER BY updated_at DESC')) {
      return { rows: opts.recentInterestRows ?? [], rowCount: 0 };
    }
    if (sql.includes('FROM member_interests')) {
      return { rows: opts.interestRows ?? [], rowCount: 0 };
    }
    if (sql.includes('FROM member_projects')) {
      return { rows: opts.projectRows ?? [], rowCount: 0 };
    }
    if (sql.includes('FROM policies')) {
      const key = params[0];
      if (key === 'community_guidelines') {
        return { rows: opts.guidelines !== undefined ? [{ value: opts.guidelines }] : [], rowCount: 0 };
      }
      if (key === 'community_guidelines_mi') {
        return { rows: opts.guidelinesMi !== undefined ? [{ value: opts.guidelinesMi }] : [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM language_prefs')) {
      return { rows: opts.languagePref ? [{ language: opts.languagePref }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  return calls;
}

interface FakeReply {
  content: string;
  ephemeral: boolean;
}

/**
 * Minimal `ChatInputCommandInteraction` stand-in — just enough surface for
 * `handleInteraction`: `commandName`, `user.id` (identity, per criterion 3
 * ALWAYS resolved via `resolveRole`, never anything else on this object),
 * `channelId`, `options.getString`, and `deferReply`/`editReply`/`followUp`
 * collectors. Mirrors the real defer-then-edit pattern (PR #748 review):
 * `deferReply` is where the ephemeral flag is actually set in Discord's API
 * (`editReply` carries no flags param), so `replies` is populated from
 * `editReply`, marked ephemeral iff a prior `deferReply` requested it — same
 * as `reply()` used to, but only reachable after an ack. `order` records call
 * names in sequence so tests can assert `deferReply` happened first, before
 * any DB/embedding round trip. Carries an extra `member.permissions` field on
 * some tests standing in for Discord's own (unrelated) guild-permission data,
 * to prove the handler never reads it as an authorization signal.
 */
function fakeInteraction(opts: {
  commandName: string;
  userId?: string;
  channelId?: string;
  options?: Record<string, string | null>;
  booleanOptions?: Record<string, boolean | null>;
  spoofedAdminClaim?: boolean;
}): { interaction: unknown; replies: FakeReply[]; followUps: FakeReply[]; order: string[] } {
  const replies: FakeReply[] = [];
  const followUps: FakeReply[] = [];
  const order: string[] = [];
  let deferredEphemeral = false;
  const interaction = {
    isChatInputCommand: () => true,
    commandName: opts.commandName,
    user: { id: opts.userId ?? 'user-1' },
    channelId: opts.channelId ?? 'chan-1',
    // A caller-forgeable field with no bearing on the bot's own RBAC tiers —
    // present only to prove criterion 3 (identity/role never trusted from
    // the interaction payload).
    member: opts.spoofedAdminClaim
      ? { permissions: { has: () => true }, roles: { cache: new Map() } }
      : undefined,
    options: {
      getString: (name: string) => opts.options?.[name] ?? null,
      getBoolean: (name: string) => opts.booleanOptions?.[name] ?? null,
    },
    deferReply: async (payload: { flags?: number }) => {
      order.push('deferReply');
      deferredEphemeral = payload.flags === MessageFlags.Ephemeral;
    },
    editReply: async (payload: { content: string }) => {
      order.push('editReply');
      replies.push({ content: payload.content, ephemeral: deferredEphemeral });
    },
    followUp: async (payload: { content: string; flags?: number }) => {
      order.push('followUp');
      followUps.push({ content: payload.content, ephemeral: payload.flags === MessageFlags.Ephemeral });
    },
  };
  return { interaction, replies, followUps, order };
}

/** Reaches the real, private `filtered()` outbound-filter method (secret redaction + code policy). */
function adapterDeps(adapter: Adapter): { filtered: (text: string) => Promise<string> } {
  return {
    filtered: (text: string) =>
      (adapter as unknown as { filtered: (t: string) => Promise<string> }).filtered(text),
  };
}

// --- Criterion 1 / SECURITY criterion 11: flag off ---------------------------

test('SECURITY: with DISCORD_SLASH_COMMANDS_ENABLED unset, no InteractionCreate listener is attached and no commands are registered (acceptance criterion 1)', async (t) => {
  const flag = slashFlag();
  const was = flag.slashCommandsEnabled;
  flag.slashCommandsEnabled = false;
  t.after(() => {
    flag.slashCommandsEnabled = was;
  });

  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const client = (
    adapter as unknown as {
      client: {
        listenerCount: (event: string) => number;
        login: (token: string) => Promise<void>;
        emit: (event: string, ...args: unknown[]) => void;
        application?: { commands: { set: (...args: unknown[]) => Promise<unknown> } };
      };
    }
  ).client;
  client.login = async () => {};
  const setCalls: unknown[][] = [];
  client.application = { commands: { set: async (...args: unknown[]) => (setCalls.push(args), []) } };

  await adapter.start();
  assert.equal(
    client.listenerCount(Events.InteractionCreate),
    0,
    'no Events.InteractionCreate handler may be attached when the flag is off',
  );

  client.emit(Events.ClientReady, { user: { tag: 'bot#0000' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(setCalls.length, 0, 'no application command registration call may fire when the flag is off');
});

// --- Criterion 2 / SECURITY criterion 16: flag on, guild-scoped registration -

test('with DISCORD_SLASH_COMMANDS_ENABLED=true, the four commands are registered guild-scoped on ClientReady, and an InteractionCreate listener IS attached (acceptance criterion 2)', async (t) => {
  const flag = slashFlag();
  const was = flag.slashCommandsEnabled;
  flag.slashCommandsEnabled = true;
  t.after(() => {
    flag.slashCommandsEnabled = was;
  });

  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const client = (
    adapter as unknown as {
      client: {
        listenerCount: (event: string) => number;
        login: (token: string) => Promise<void>;
        emit: (event: string, ...args: unknown[]) => void;
        application?: { commands: { set: (...args: unknown[]) => Promise<unknown> } };
      };
    }
  ).client;
  client.login = async () => {};
  const setCalls: unknown[][] = [];
  client.application = { commands: { set: async (...args: unknown[]) => (setCalls.push(args), []) } };

  await adapter.start();
  assert.equal(
    client.listenerCount(Events.InteractionCreate),
    1,
    'exactly one Events.InteractionCreate handler must be attached when the flag is on',
  );

  client.emit(Events.ClientReady, { user: { tag: 'bot#0000' } });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(setCalls.length, 1, 'registration must fire exactly once on ClientReady');
  const [commands, guildId] = setCalls[0];
  assert.equal(guildId, config.discord.guildId, 'SECURITY: registration must target config.discord.guildId');
  assert.notEqual(
    guildId,
    undefined,
    'SECURITY: registration must never be global (a call with no guild arg)',
  );
  const names = (commands as Array<{ name: string }>).map((c) => c.name).sort();
  assert.deepEqual(names, ['digest', 'guidelines', 'kb', 'projects', 'whois']);
});

test("a slash-command registration failure is caught and logged, never thrown, matching backfillRoster/reconcileMutedRole's fire-and-forget shape", async (t) => {
  const warnLog = t.mock.method(logger, 'warn', () => {});
  const client = {
    application: {
      commands: {
        set: async () => {
          throw new Error('Discord API unavailable');
        },
      },
    },
  };
  await assert.doesNotReject(() => registerSlashCommands(client as never));
  assert.ok(warnLog.mock.calls.length >= 1, 'a registration failure must be logged, not swallowed silently');
});

test('buildSlashCommands defines exactly the five approved read-only commands, each with its expected required-ness', () => {
  const commands = buildSlashCommands();
  const byName = new Map(commands.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ['digest', 'guidelines', 'kb', 'projects', 'whois']);
  const requiredness = (name: string) =>
    (byName.get(name) as { options?: Array<{ name: string; required?: boolean }> }).options?.find(
      (o) => o.name === 'query',
    )?.required;
  assert.equal(requiredness('kb'), true);
  assert.equal(
    requiredness('whois'),
    false,
    'issue #882: /whois query is optional (omit to find members like you)',
  );
  assert.equal(requiredness('projects'), false);
  const seekingCollaboratorsOption = (
    byName.get('projects') as {
      options?: Array<{ name: string; type: number; required?: boolean }>;
    }
  ).options?.find((o) => o.name === 'seeking_collaborators');
  assert.ok(seekingCollaboratorsOption, '/projects must define a seeking_collaborators option (issue #854)');
  assert.equal(seekingCollaboratorsOption?.required, false);
  const mineOption = (
    byName.get('projects') as {
      options?: Array<{ name: string; type: number; required?: boolean }>;
    }
  ).options?.find((o) => o.name === 'mine');
  assert.ok(mineOption, '/projects must define a mine option (issue #867)');
  assert.equal(mineOption?.required, false);
  assert.deepEqual((byName.get('guidelines') as { options?: unknown[] }).options ?? [], []);
  assert.deepEqual(
    (byName.get('digest') as { options?: unknown[] }).options ?? [],
    [],
    '/digest takes no options — always the current on-demand snapshot, never a windowed query',
  );
});

// --- Criterion 3: identity/role resolved only via resolveRole(platform, userId) -

test('SECURITY: authorization is resolved via resolveRole(platform, userId) only — a spoofed admin-looking field on the interaction payload changes nothing (acceptance criterion 3)', async (t) => {
  const calls = mockPool(t, { memberRole: null }); // 'guest-1' has no community_users row
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'guest-1',
    options: { query: 'rag' },
    spoofedAdminClaim: true,
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_interests')),
    "a guest must be rejected — resolveRole(platform, userId), not the payload's spoofed claim, governs",
  );
});

// --- Criterion 4 / SECURITY criterion 12: authorization gates -----------------

test("SECURITY: a guest caller is rejected on /whois without who_is_into's repository function ever being invoked (acceptance criteria 4, 12)", async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'guest-1',
    options: { query: 'rag' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(!replies[0].content.includes('member-interests'));
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_interests')),
    'searchMemberInterests must never be called for a rejected caller',
  );
});

test("SECURITY: a guest caller is rejected on /projects without list_projects's repository function ever being invoked (acceptance criteria 4, 12)", async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'guest-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_projects')),
    'listRecentProjects/searchProjects must never be called for a rejected caller',
  );
});

test('SECURITY: a guest caller is rejected on /projects regardless of the seeking_collaborators option value (issue #854 AC #6)', async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'projects',
    userId: 'guest-1',
    booleanOptions: { seeking_collaborators: true },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_projects')),
    'the seeking_collaborators option must never let a guest reach listRecentProjects/searchProjects',
  );
});

test('/projects seeking_collaborators:true threads the same filter through as list_projects, on both the no-query and query paths (issue #854 AC #5)', async (t) => {
  const calls = mockPool(t, { memberRole: 'member', projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  const noQuery = fakeInteraction({
    commandName: 'projects',
    userId: 'member-1',
    booleanOptions: { seeking_collaborators: true },
  });
  await handleInteraction(noQuery.interaction as never, adapterDeps(adapter));
  const noQueryCall = calls.find((c) => c.sql.includes('FROM member_projects') && !c.sql.includes('<=>'));
  assert.ok(noQueryCall, 'the no-query path must have run');
  assert.match(
    noQueryCall.sql,
    /AND seeking_collaborators/,
    'seeking_collaborators:true must narrow the no-query listRecentProjects call exactly as list_projects does',
  );

  calls.length = 0;
  const withQuery = fakeInteraction({
    commandName: 'projects',
    userId: 'member-1',
    options: { query: 'rag' },
    booleanOptions: { seeking_collaborators: true },
  });
  await handleInteraction(withQuery.interaction as never, adapterDeps(adapter));
  const queryCall = calls.find((c) => c.sql.includes('FROM member_projects') && c.sql.includes('<=>'));
  assert.ok(queryCall, 'the query path must have run');
  assert.match(
    queryCall.sql,
    /AND seeking_collaborators/,
    'seeking_collaborators:true must narrow the query-path searchProjects call exactly as list_projects does',
  );

  calls.length = 0;
  const omitted = fakeInteraction({ commandName: 'projects', userId: 'member-1' });
  await handleInteraction(omitted.interaction as never, adapterDeps(adapter));
  const omittedCall = calls.find((c) => c.sql.includes('FROM member_projects'));
  assert.ok(omittedCall);
  assert.doesNotMatch(
    omittedCall.sql,
    /AND seeking_collaborators/,
    'omitting seeking_collaborators must stay byte-identical to the unfiltered SQL',
  );
});

test('/projects seeking_collaborators:true with no matching rows replies with the distinct filtered empty-state message (issue #854 AC #4, #5)', async (t) => {
  mockPool(t, { memberRole: 'member', projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'projects',
    userId: 'member-1',
    booleanOptions: { seeking_collaborators: true },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.match(replies[0].content, /No projects are currently looking for collaborators\./);
});

test('SECURITY: a guest caller is rejected on /projects regardless of the mine option value (issue #867)', async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'projects',
    userId: 'guest-1',
    booleanOptions: { mine: true },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_projects')),
    'the mine option must never let a guest reach listOwnProjects',
  );
});

test('/projects mine:true calls listOwnProjects scoped to the caller identity, ignores query/seeking_collaborators, and has a distinct empty-state message (issue #867)', async (t) => {
  const calls = mockPool(t, { memberRole: 'member', projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'projects',
    userId: 'member-1',
    options: { query: 'rag' },
    booleanOptions: { mine: true, seeking_collaborators: true },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  const mineCall = calls.find((c) => c.sql.includes('FROM member_projects'));
  assert.ok(mineCall, 'listOwnProjects must have run');
  assert.match(mineCall.sql, /WHERE platform = \$1 AND user_id = \$2/);
  assert.doesNotMatch(
    mineCall.sql,
    /<=>/,
    'mine:true must never fall through to the embedding-similarity search path',
  );
  assert.deepEqual(mineCall.params, ['discord', 'member-1']);
  assert.match(replies[0].content, /You haven't shared any projects yet\./);
});

test("SECURITY: /kb tracks knowledge_search's own toolsForRole reachability rather than a hardcoded role check — a guest CAN use /kb, exactly like the chat-path tool (acceptance criteria 4, 12)", async (t) => {
  mockPool(t, {
    memberRole: null,
    knowledgeRows: [
      {
        id: 1,
        title: 'FAQ',
        content: 'trusted answer',
        created_by_role: 'admin',
        similarity: 0.9,
        updated_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'guest-1',
    options: { query: 'faq' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.ok(
    !replies[0].content.includes("don't have access"),
    'a guest must NOT be rejected on /kb — knowledge_search has no extra role floor beyond toolsForRole',
  );
  assert.ok(replies[0].content.includes('trusted answer'));
});

test('a member caller passes the /whois and /projects gates (not rejected)', async (t) => {
  mockPool(t, { memberRole: 'member', interestRows: [], projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  const whois = fakeInteraction({ commandName: 'whois', userId: 'member-1', options: { query: 'rag' } });
  await handleInteraction(whois.interaction as never, adapterDeps(adapter));
  assert.ok(!whois.replies[0].content.includes("don't have access"));

  const projects = fakeInteraction({ commandName: 'projects', userId: 'member-1' });
  await handleInteraction(projects.interaction as never, adapterDeps(adapter));
  assert.ok(!projects.replies[0].content.includes("don't have access"));
});

// --- Criterion 5: every reply is ephemeral ------------------------------------

test('acceptance criterion 5: every one of the four commands replies ephemerally, including a rejection reply', async (t) => {
  resetPolicyCacheForTests();
  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [],
    interestRows: [],
    projectRows: [],
    guidelines: 'Be kind.',
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  for (const commandName of ['kb', 'whois', 'projects', 'guidelines']) {
    const { interaction, replies } = fakeInteraction({
      commandName,
      userId: 'member-1',
      options: { query: 'anything' },
    });
    await handleInteraction(interaction as never, adapterDeps(adapter));
    assert.equal(replies.length, 1, `${commandName} must reply exactly once`);
    assert.equal(replies[0].ephemeral, true, `${commandName}'s reply must be ephemeral`);
  }
});

test('acceptance criterion 5: a rejection reply is ephemeral too, not just a successful answer', async (t) => {
  mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'whois', userId: 'guest-2' });
  await handleInteraction(interaction as never, adapterDeps(adapter));
  assert.equal(replies[0].ephemeral, true);
});

// --- PR #748 review: deferReply before any async work (3s ack window) --------

test('PR #748 review: every command calls deferReply before its first reply/DB round trip — Discord expires an unacknowledged interaction token after 3s', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [],
    interestRows: [],
    projectRows: [],
    guidelines: 'Be kind.',
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  for (const commandName of ['kb', 'whois', 'projects', 'guidelines']) {
    const { interaction, order } = fakeInteraction({
      commandName,
      userId: 'member-1',
      options: { query: 'anything' },
    });
    await handleInteraction(interaction as never, adapterDeps(adapter));
    assert.equal(order[0], 'deferReply', `${commandName} must call deferReply before anything else`);
  }
});

test('PR #748 review: deferReply happens before the (potentially slow) embedding/DB lookup, not after — rejection and success paths both defer first', async (t) => {
  const queryOrder: string[] = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    queryOrder.push(sql);
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: [{ role: 'member' }], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, order } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(queryOrder.length > 0, 'a DB round trip must have happened');
  assert.equal(
    order[0],
    'deferReply',
    'deferReply must be the very first call, before role resolution or search',
  );
  assert.ok(order.indexOf('deferReply') < order.indexOf('editReply'), 'defer must precede the final answer');
});

// --- Criterion 6 / SECURITY criterion 13: outbound filter ---------------------

test('SECURITY: /kb routes its reply through the same outbound filter as every other send path — a secret cannot reach Discord unredacted (acceptance criteria 6, 13)', async (t) => {
  const secret = 'sk-ant-' + 'y'.repeat(30);
  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [
      {
        id: 1,
        title: 'Keys',
        content: `here is a secret ${secret} end`,
        created_by_role: 'admin',
        similarity: 0.9,
        updated_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'keys' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.ok(!replies[0].content.includes('sk-ant-'), 'no raw secret fragment may reach the ephemeral reply');
  assert.ok(replies[0].content.includes('[redacted]'), 'the secret must be redacted, not silently dropped');
});

test('SECURITY: /guidelines also routes through the outbound filter (every slash-command reply, not just /kb)', async (t) => {
  resetPolicyCacheForTests();
  const secret = 'sk-ant-' + 'z'.repeat(30);
  mockPool(t, { memberRole: 'member', guidelines: `Be nice. Contact ${secret} for help.` });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'guidelines', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(!replies[0].content.includes('sk-ant-'));
  assert.ok(replies[0].content.includes('[redacted]'));
});

// --- Criterion 7 / SECURITY criterion 14: /kb excludes auto-provenance -------

test('SECURITY: /kb never direct-serves an unreviewed auto-provenance knowledge entry (acceptance criteria 7, 14)', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [
      {
        id: 1,
        title: 'Auto',
        content: 'AUTO_UNVERIFIED_TEXT',
        created_by_role: 'auto',
        similarity: 0.95,
        updated_at: new Date(),
      },
      {
        id: 2,
        title: 'Trusted',
        content: 'ADMIN_TRUSTED_TEXT',
        created_by_role: 'admin',
        similarity: 0.9,
        updated_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(
    !replies[0].content.includes('AUTO_UNVERIFIED_TEXT'),
    'an auto-provenance entry must never be served',
  );
  assert.ok(replies[0].content.includes('ADMIN_TRUSTED_TEXT'), 'a trusted entry must still be served');
});

test('/kb replies with the no-match text when every hit is auto-provenance (all excluded, none quarantined-and-shown)', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [
      {
        id: 1,
        title: 'Auto',
        content: 'AUTO_ONLY',
        created_by_role: 'auto',
        similarity: 0.95,
        updated_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'x' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies[0].content, 'No matching knowledge entries.');
});

// --- Criteria 1/2 (conflict/low-rated caveats), issue #802 --------------------

test('SECURITY: /kb reply includes KNOWLEDGE_CONFLICT_CAVEAT_TEXT when hasConflictAmongIds resolves true for >=2 relevant hits, and omits it when false', async (t) => {
  const knowledgeRows: PoolRow[] = [
    {
      id: 1,
      title: 'A',
      content: 'ENTRY_A_TEXT',
      created_by_role: 'admin',
      similarity: 0.9,
      updated_at: new Date(),
    },
    {
      id: 2,
      title: 'B',
      content: 'ENTRY_B_TEXT',
      created_by_role: 'admin',
      similarity: 0.85,
      updated_at: new Date(),
    },
  ];

  mockPool(t, { memberRole: 'member', knowledgeRows, conflictExists: true });
  const adapterConflict = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction: iConflict, replies: repliesConflict } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });
  await handleInteraction(iConflict as never, adapterDeps(adapterConflict));
  assert.ok(
    repliesConflict[0].content.includes(stripEmDashes(KNOWLEDGE_CONFLICT_CAVEAT_TEXT)),
    'the caveat must render when hasConflictAmongIds resolves true for >=2 relevant hits',
  );

  mockPool(t, { memberRole: 'member', knowledgeRows, conflictExists: false });
  const adapterNoConflict = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction: iNoConflict, replies: repliesNoConflict } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });
  await handleInteraction(iNoConflict as never, adapterDeps(adapterNoConflict));
  assert.ok(
    !repliesNoConflict[0].content.includes(stripEmDashes(KNOWLEDGE_CONFLICT_CAVEAT_TEXT)),
    'the caveat must be omitted when hasConflictAmongIds resolves false',
  );
});

test('SECURITY: /kb reply includes KNOWLEDGE_LOW_RATED_CAVEAT_TEXT on exactly the hit line whose id is in the low-rated set, never on a sibling hit outside it', async (t) => {
  const was = config.behaviour.knowledgeLowRatedCaveatMinUnhelpful;
  config.behaviour.knowledgeLowRatedCaveatMinUnhelpful = 2;
  t.after(() => {
    config.behaviour.knowledgeLowRatedCaveatMinUnhelpful = was;
  });

  mockPool(t, {
    memberRole: 'member',
    knowledgeRows: [
      {
        id: 1,
        title: 'Low-rated entry',
        content: 'LOW_RATED_ENTRY_TEXT',
        created_by_role: 'admin',
        similarity: 0.9,
        updated_at: new Date(),
      },
      {
        id: 2,
        title: 'Fine entry',
        content: 'FINE_ENTRY_TEXT',
        created_by_role: 'admin',
        similarity: 0.85,
        updated_at: new Date(),
      },
    ],
    lowRatedIds: [1],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  const [lowRatedLine, fineLine] = replies[0].content
    .split('\n')
    .filter((line) => line.includes('LOW_RATED_ENTRY_TEXT') || line.includes('FINE_ENTRY_TEXT'));
  assert.ok(
    lowRatedLine?.includes(stripEmDashes(KNOWLEDGE_LOW_RATED_CAVEAT_TEXT)),
    "the low-rated entry's own line must carry the caveat",
  );
  assert.ok(
    !fineLine?.includes(stripEmDashes(KNOWLEDGE_LOW_RATED_CAVEAT_TEXT)),
    'a sibling hit outside the low-rated set must never carry the caveat',
  );
});

test('SECURITY: /kb still replies successfully with the hits and no caveat when hasConflictAmongIds and areKnowledgeEntriesLowRated both reject (fail-safe)', async (t) => {
  const was = config.behaviour.knowledgeLowRatedCaveatMinUnhelpful;
  config.behaviour.knowledgeLowRatedCaveatMinUnhelpful = 2;
  t.after(() => {
    config.behaviour.knowledgeLowRatedCaveatMinUnhelpful = was;
  });
  const warnLog = t.mock.method(logger, 'warn', () => {});

  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: [{ role: 'member' }], rowCount: 0 };
    }
    if (sql.includes('JOIN knowledge b')) {
      throw new Error('conflict lookup unavailable');
    }
    if (sql.includes('FROM answer_feedback')) {
      throw new Error('low-rated lookup unavailable');
    }
    if (sql.includes('FROM knowledge')) {
      return {
        rows: [
          {
            id: 1,
            title: 'A',
            content: 'STILL_SERVED_TEXT',
            created_by_role: 'admin',
            similarity: 0.9,
            updated_at: new Date(),
          },
          {
            id: 2,
            title: 'B',
            content: 'ALSO_SERVED_TEXT',
            created_by_role: 'admin',
            similarity: 0.85,
            updated_at: new Date(),
          },
        ],
        rowCount: 0,
      };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    options: { query: 'anything' },
  });

  await assert.doesNotReject(() => handleInteraction(interaction as never, adapterDeps(adapter)));

  assert.equal(replies.length, 1);
  assert.ok(replies[0].content.includes('STILL_SERVED_TEXT'), 'the hits must still be served');
  assert.ok(replies[0].content.includes('ALSO_SERVED_TEXT'), 'the hits must still be served');
  assert.ok(
    !replies[0].content.includes(KNOWLEDGE_CONFLICT_CAVEAT_TEXT),
    'a lookup failure must degrade to no conflict caveat, never an error',
  );
  assert.ok(
    !replies[0].content.includes(KNOWLEDGE_LOW_RATED_CAVEAT_TEXT),
    'a lookup failure must degrade to no low-rated caveat, never an error',
  );
  assert.ok(warnLog.mock.calls.length >= 2, 'both lookup failures must be logged, not silently swallowed');
});

// --- Criterion 8: /whois, /projects preserve untrusted-content sanitization ---

test("SECURITY: /whois preserves who_is_into's untrusted-content quarantine — angle brackets stripped, never raw repository rows (acceptance criterion 8)", async (t) => {
  mockPool(t, {
    memberRole: 'member',
    interestRows: [
      {
        platform: 'discord',
        user_id: 'target-1',
        interests: '<script>alert(1)</script> RAG systems',
        similarity: 0.8,
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: { query: 'rag' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(
    !replies[0].content.includes('<script>'),
    'angle brackets must be stripped, not passed through raw',
  );
  assert.ok(replies[0].content.includes('member-interests'), 'must use the quarantine wrapper, not raw rows');
});

// --- Issue #882: /whois with the query option omitted -----------------------

test('/whois with no query option and a published row for the caller renders the self-match results, mirroring who_is_into (issue #882 acceptance criterion 5)', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    interestRows: [
      { platform: 'discord', user_id: 'target-1', interests: 'RAG systems with pgvector', similarity: 0.8 },
    ],
    projectRows: [],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: {},
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /RAG systems with pgvector/);
});

test('/whois with no query option and no published row for the caller returns guidance to set_my_interests, mirroring who_is_into (issue #882 acceptance criterion 5)', async (t) => {
  mockPool(t, { memberRole: 'member', interestRows: [], projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: {},
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /haven't published interests yet/i);
});

test('/whois with no query option and no published row for the caller browses recently published interests via listRecentInterests, still appending the set_my_interests hint (issue #920 AC #4)', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    interestRows: [],
    recentInterestRows: [
      { platform: 'discord', user_id: 'browsed-1', interests: 'recently published interests' },
    ],
    projectRows: [],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: {},
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /recently published interests/);
  assert.match(
    replies[0].content,
    /haven't published interests yet/i,
    'the set_my_interests hint still appends after the browsed list',
  );
});

test('/whois <query> remains byte-identical to today when a query IS supplied, even though the option is now optional (issue #882 acceptance criterion 5)', async (t) => {
  mockPool(t, {
    memberRole: 'member',
    interestRows: [
      { platform: 'discord', user_id: 'target-1', interests: 'RAG systems with pgvector', similarity: 0.8 },
    ],
    projectRows: [],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: { query: 'rag' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /RAG systems with pgvector/);
  assert.doesNotMatch(replies[0].content, /haven't published interests yet/i);
});

test("SECURITY: /projects preserves list_projects's untrusted-content quarantine — angle brackets stripped (acceptance criterion 8)", async (t) => {
  mockPool(t, {
    memberRole: 'member',
    projectRows: [
      {
        id: 1,
        platform: 'discord',
        user_id: 'owner-1',
        name: '<img src=x onerror=alert(1)>',
        description: 'a cool project',
        link: null,
        created_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(!replies[0].content.includes('<img'));
  assert.ok(replies[0].content.includes('shared-projects'));
});

// --- Criterion 9 / SECURITY criterion 15: /kb caller-scoped searchKnowledge --

test("SECURITY: /kb passes the caller's real (platform, conversationId) to searchKnowledge, never a hardcoded or global-only scope (acceptance criteria 9, 15)", async (t) => {
  const calls = mockPool(t, { memberRole: 'member', knowledgeRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({
    commandName: 'kb',
    userId: 'member-1',
    channelId: 'this-callers-channel',
    options: { query: 'anything' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  const knowledgeCall = calls.find((c) => c.sql.includes('FROM knowledge'));
  assert.ok(knowledgeCall, 'searchKnowledge must have been called');
  assert.equal(knowledgeCall.params[1], 'discord');
  assert.equal(
    knowledgeCall.params[2],
    'this-callers-channel',
    "the caller's own channelId must be threaded through as conversationId — not a different/global scope",
  );
});

// --- /digest (issue #841): on-demand pull of the community digest ------------

test("SECURITY: a guest caller is rejected on /digest without buildMemberDigestContent's repository reads ever being invoked (acceptance criteria 4)", async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'digest', userId: 'guest-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(
    !calls.some(
      (c) =>
        c.sql.includes('FROM context_digests') ||
        c.sql.includes('FROM member_projects') ||
        c.sql.includes('FROM knowledge_candidates') ||
        c.sql.includes('FROM member_interests'),
    ),
    'buildMemberDigestContent must never be invoked for a rejected caller',
  );
});

test("a member caller passes the /digest gate, defers before any DB read, and replies ephemerally with buildMemberDigestContent()'s own content (acceptance criteria 3, 5)", async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT role FROM community_users')) {
      return { rows: [{ role: 'member' }], rowCount: 0 };
    }
    if (sql.includes('FROM context_digests')) {
      return { rows: [], rowCount: 0 };
    }
    // countAcceptedMemberKnowledgeTipsSince — checked before the generic
    // 'FROM knowledge' branch below, since its own SQL text contains that
    // substring too ('FROM knowledge_candidates').
    if (sql.includes('FROM knowledge_candidates')) {
      return { rows: [{ n: '0' }], rowCount: 0 };
    }
    if (sql.includes('FROM member_projects')) {
      return { rows: [{ n: '2' }], rowCount: 0 };
    }
    // countInterestsPublishedSince (issue #815) — a 6th read buildMemberDigestContent
    // now issues alongside the other five.
    if (sql.includes('FROM member_interests')) {
      return { rows: [{ n: '0' }], rowCount: 0 };
    }
    if (sql.includes('FROM knowledge')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies, order } = fakeInteraction({ commandName: 'digest', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.equal(order[0], 'deferReply', 'must defer before any DB read');
  assert.equal(
    replies[0].content,
    // Passes through deps.filtered() like every other slash-command reply,
    // which rewrites em dashes into a comma (stripEmDashes in outbound.ts) —
    // same rationale this file's own top-of-file comment documents for the
    // /kb caveat-text assertions above.
    stripEmDashes(
      '🚀 2 new projects added to the showcase this week — ask me to show the project showcase to browse.',
    ),
    "reply is exactly buildMemberDigestContent()'s own render for this mocked signal mix, post-filter",
  );
});

test('/digest replies with the fixed "Nothing to report right now." text when buildMemberDigestContent resolves null (acceptance criteria 2 parity)', async (t) => {
  t.mock.method(pool, 'query', (async (sql: string) => {
    if (sql.includes('SELECT role FROM community_users')) return { rows: [{ role: 'member' }], rowCount: 0 };
    if (sql.includes('FROM knowledge_candidates')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_projects')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_interests')) return { rows: [{ n: '0' }], rowCount: 0 };
    // FROM context_digests and the generic FROM knowledge (curated titles)
    // branches both resolve to an empty row set — every input empty renders
    // null (formatMemberDigestMessage's own silence-over-noise contract).
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'digest', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies[0].content, 'Nothing to report right now.');
});

test('SECURITY: /digest never wraps its reply in untrusted() — unlike community_digest, this reply never re-enters model context', async (t) => {
  t.mock.method(pool, 'query', (async (sql: string) => {
    if (sql.includes('SELECT role FROM community_users')) return { rows: [{ role: 'member' }], rowCount: 0 };
    if (sql.includes('FROM context_digests')) {
      return {
        rows: [
          {
            id: 1,
            period_start: new Date(),
            period_end: new Date(),
            platform: 'discord',
            topic: 'MCP server auth',
            summary: 's',
            example_refs: [],
            distinct_users: 3,
            question_count: 2,
            created_at: new Date(),
          },
        ],
        rowCount: 0,
      };
    }
    if (sql.includes('FROM knowledge_candidates')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_projects')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_interests')) return { rows: [{ n: '0' }], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'digest', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.doesNotMatch(
    replies[0].content,
    /untrusted past chat content/,
    '/digest must render buildMemberDigestContent() plain, never quarantined via untrusted()',
  );
  assert.match(replies[0].content, /MCP server auth/);
});

// --- Rejection text and non-command interactions ------------------------------

test('a rejected caller receives a clear rejection message and no other side effects', async (t) => {
  mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'guest-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /don't have access/i);
});

test('handleInteraction ignores every non-chat-input interaction (e.g. a button click) without throwing', async (t) => {
  mockPool(t);
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const nonCommand = { isChatInputCommand: () => false };
  await assert.doesNotReject(() => handleInteraction(nonCommand as never, adapterDeps(adapter)));
});

// --- Issue #863: slash-command usage counted into shortcut_hits --------------

/** Every `INSERT INTO shortcut_hits` call recorded across a set of pool.query calls. */
function shortcutHitCalls(
  calls: Array<{ sql: string; params: unknown[] }>,
): Array<{ sql: string; params: unknown[] }> {
  return calls.filter((c) => c.sql.includes('INSERT INTO shortcut_hits'));
}

test("a successful /kb invocation calls recordShortcutHit('slash_command') exactly once (issue #863 acceptance criterion 1)", async (t) => {
  const calls = mockPool(t, {
    memberRole: null,
    knowledgeRows: [
      {
        id: 1,
        title: 'FAQ',
        content: 'trusted answer',
        created_by_role: 'admin',
        similarity: 0.9,
        updated_at: new Date(),
      },
    ],
  });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({
    commandName: 'kb',
    userId: 'guest-1',
    options: { query: 'faq' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  const hits = shortcutHitCalls(calls);
  assert.equal(hits.length, 1, '/kb must record exactly one slash_command hit');
  assert.deepEqual(hits[0].params, ['slash_command']);
});

test("a successful /whois invocation calls recordShortcutHit('slash_command') exactly once (issue #863 acceptance criterion 1)", async (t) => {
  const calls = mockPool(t, { memberRole: 'member', interestRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({
    commandName: 'whois',
    userId: 'member-1',
    options: { query: 'rag' },
  });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(shortcutHitCalls(calls).length, 1, '/whois must record exactly one slash_command hit');
});

test("a successful /projects invocation calls recordShortcutHit('slash_command') exactly once (issue #863 acceptance criterion 1)", async (t) => {
  const calls = mockPool(t, { memberRole: 'member', projectRows: [] });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({ commandName: 'projects', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(shortcutHitCalls(calls).length, 1, '/projects must record exactly one slash_command hit');
});

test("a successful /guidelines invocation calls recordShortcutHit('slash_command') exactly once (issue #863 acceptance criterion 1)", async (t) => {
  resetPolicyCacheForTests();
  const calls = mockPool(t, { guidelines: 'Be kind.' });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({ commandName: 'guidelines', userId: 'anyone-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(shortcutHitCalls(calls).length, 1, '/guidelines must record exactly one slash_command hit');
});

test("a successful /digest invocation calls recordShortcutHit('slash_command') exactly once (issue #863 acceptance criterion 1)", async (t) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT role FROM community_users')) return { rows: [{ role: 'member' }], rowCount: 0 };
    if (sql.includes('FROM knowledge_candidates')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_projects')) return { rows: [{ n: '0' }], rowCount: 0 };
    if (sql.includes('FROM member_interests')) return { rows: [{ n: '0' }], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);
  const { interaction } = fakeInteraction({ commandName: 'digest', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(shortcutHitCalls(calls).length, 1, '/digest must record exactly one slash_command hit');
});

test('SECURITY: recordShortcutHit is never called on the NOT_AUTHORIZED_TEXT branch for /whois or /projects (issue #863 acceptance criterion 4/security criterion 5)', async (t) => {
  const calls = mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter(DISCORD_TEXT_PACK);

  const whois = fakeInteraction({ commandName: 'whois', userId: 'guest-1', options: { query: 'rag' } });
  await handleInteraction(whois.interaction as never, adapterDeps(adapter));
  assert.match(whois.replies[0].content, /don't have access/i, 'sanity check: /whois was actually denied');

  const projects = fakeInteraction({ commandName: 'projects', userId: 'guest-1' });
  await handleInteraction(projects.interaction as never, adapterDeps(adapter));
  assert.match(
    projects.replies[0].content,
    /don't have access/i,
    'sanity check: /projects was actually denied',
  );

  assert.equal(
    shortcutHitCalls(calls).length,
    0,
    'an auth-denied reply must never record a shortcut hit — that would let the counter be used to infer auth-denied probe volume',
  );
});
