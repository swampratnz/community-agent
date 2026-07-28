import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
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
const { resetPolicyCacheForTests } = await import('../src/storage/policies.js');
const { handleInteraction, buildSlashCommands, registerSlashCommands } =
  await import('../src/platforms/discord/slashCommands.js');
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

  const adapter = new DiscordAdapter();
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

  const adapter = new DiscordAdapter();
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
  assert.deepEqual(names, ['guidelines', 'kb', 'projects', 'whois']);
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

test('buildSlashCommands defines exactly the four approved read-only commands, each with its expected required-ness', () => {
  const commands = buildSlashCommands();
  const byName = new Map(commands.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ['guidelines', 'kb', 'projects', 'whois']);
  const requiredness = (name: string) =>
    (byName.get(name) as { options?: Array<{ name: string; required?: boolean }> }).options?.find(
      (o) => o.name === 'query',
    )?.required;
  assert.equal(requiredness('kb'), true);
  assert.equal(requiredness('whois'), true);
  assert.equal(requiredness('projects'), false);
  assert.deepEqual((byName.get('guidelines') as { options?: unknown[] }).options ?? [], []);
});

// --- Criterion 3: identity/role resolved only via resolveRole(platform, userId) -

test('SECURITY: authorization is resolved via resolveRole(platform, userId) only — a spoofed admin-looking field on the interaction payload changes nothing (acceptance criterion 3)', async (t) => {
  const calls = mockPool(t, { memberRole: null }); // 'guest-1' has no community_users row
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'guest-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.ok(
    !calls.some((c) => c.sql.includes('FROM member_projects')),
    'listRecentProjects/searchProjects must never be called for a rejected caller',
  );
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();

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
  const adapter = new DiscordAdapter();

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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();

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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapterConflict = new DiscordAdapter();
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
  const adapterNoConflict = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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

  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
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
  const adapter = new DiscordAdapter();
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'member-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.ok(!replies[0].content.includes('<img'));
  assert.ok(replies[0].content.includes('shared-projects'));
});

// --- Criterion 9 / SECURITY criterion 15: /kb caller-scoped searchKnowledge --

test("SECURITY: /kb passes the caller's real (platform, conversationId) to searchKnowledge, never a hardcoded or global-only scope (acceptance criteria 9, 15)", async (t) => {
  const calls = mockPool(t, { memberRole: 'member', knowledgeRows: [] });
  const adapter = new DiscordAdapter();
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

// --- Rejection text and non-command interactions ------------------------------

test('a rejected caller receives a clear rejection message and no other side effects', async (t) => {
  mockPool(t, { memberRole: null });
  const adapter = new DiscordAdapter();
  const { interaction, replies } = fakeInteraction({ commandName: 'projects', userId: 'guest-1' });

  await handleInteraction(interaction as never, adapterDeps(adapter));

  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /don't have access/i);
});

test('handleInteraction ignores every non-chat-input interaction (e.g. a button click) without throwing', async (t) => {
  mockPool(t);
  const adapter = new DiscordAdapter();
  const nonCommand = { isChatInputCommand: () => false };
  await assert.doesNotReject(() => handleInteraction(nonCommand as never, adapterDeps(adapter)));
});
