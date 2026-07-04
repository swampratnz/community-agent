import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. Captured before the DATABASE_URL
// fallback below so the knowledge_search DB-backed test can tell a real DB
// apart from the dummy placeholder, matching tests/knowledgeEval.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

// notifyMemberApproved holds all of add_member's new (issue #75) behaviour —
// deciding whether to send the approval DM and swallowing send failures. It's
// exported and tested directly here rather than through the full MCP
// tool-call transport, which the rest of add_member (upsertMember/audited/
// clearAccessRequest, all DB-backed) already exercises via repository.test.ts.
const {
  notifyMemberApproved,
  notifySuggestionResolved,
  notifyReportResolved,
  buildToolServer,
  formatKnowledgeSearchResults,
  KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
} = await import('../src/agent/tools.js');
const { MODERATION_ACTION_KINDS, saveKnowledge, createSuggestion, createContentReport, getResponseStyle } =
  await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');
const { cancelPendingAction, hasPendingAction } = await import('../src/agent/pendingActions.js');

// Unique per test-run scope so the knowledge_search handler test's fixture
// row never collides across runs, mirroring the RUN-tag convention in
// tests/repository.test.ts and tests/knowledgeEval.test.ts.
const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const KNOWLEDGE_SEARCH_HANDLER_SCOPE = `${RUN}-knowledge-search-handler`;
const RESOLVE_SUGGESTION_HANDLER_USER = `${RUN}-resolve-suggestion-handler`;
const RESOLVE_REPORT_HANDLER_USER = `${RUN}-resolve-report-handler`;

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM knowledge WHERE scope = $1`, [KNOWLEDGE_SEARCH_HANDLER_SCOPE]);
    await pool.query(`DELETE FROM suggestions WHERE user_id = $1`, [RESOLVE_SUGGESTION_HANDLER_USER]);
    await pool.query(`DELETE FROM content_reports WHERE reporter_user_id = $1`, [
      RESOLVE_REPORT_HANDLER_USER,
    ]);
  }
  await closeDb();
});

function stubAdapter(sendDirectMessage: PlatformAdapter['sendDirectMessage']): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage,
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

test('notifyMemberApproved sends exactly one confirmation DM on a fresh grant', async () => {
  const calls: Array<[string, string]> = [];
  const adapter = stubAdapter(async (userId, text) => {
    calls.push([userId, text]);
  });

  await notifyMemberApproved(adapter, 'user-1', false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'user-1');
  assert.match(calls[0][1], /approved/i);
});

test('notifyMemberApproved signposts the community_info discovery path (issue #92)', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (_userId, message) => {
    calls.push(message);
  });

  await notifyMemberApproved(adapter, 'user-1', false);

  assert.match(calls[0], /what can you do/i);
});

test('notifyMemberApproved sends nothing when the user was already a member (re-add is a no-op)', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (userId) => {
    calls.push(userId);
  });

  await notifyMemberApproved(adapter, 'user-1', true);

  assert.equal(calls.length, 0);
});

test('notifyMemberApproved swallows a DM failure rather than throwing (grant stays the source of truth)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('DMs closed');
  });

  await assert.doesNotReject(notifyMemberApproved(adapter, 'user-1', false));
});

// notifySuggestionResolved holds all of resolve_suggestion's new (issue #116)
// notification behaviour, tested directly here the same way
// notifyMemberApproved is above.
test('notifySuggestionResolved sends a DM naming the outcome, wording differing per status', async () => {
  const calls: Array<[string, string]> = [];
  const adapter = stubAdapter(async (userId, text) => {
    calls.push([userId, text]);
  });

  await notifySuggestionResolved(adapter, 'user-1', 'done', 'add dark mode');
  await notifySuggestionResolved(adapter, 'user-1', 'reviewed', 'add dark mode');
  await notifySuggestionResolved(adapter, 'user-1', 'declined', 'add dark mode');

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'user-1');
  assert.match(calls[0][1], /done/i);
  assert.match(calls[0][1], /add dark mode/);
  assert.match(calls[1][1], /reviewed/i);
  assert.notEqual(calls[0][1], calls[1][1], 'done and reviewed get distinct wording');
  assert.notEqual(calls[0][1], calls[2][1], 'done and declined get distinct wording');
  assert.doesNotMatch(calls[2][1], /done|❌/i, 'a decline reads softer, not as a flat rejection of "done"');
});

test('notifySuggestionResolved truncates a long suggestion in the echoed confirmation', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (_userId, message) => {
    calls.push(message);
  });
  const longContent = 'x'.repeat(500);

  await notifySuggestionResolved(adapter, 'user-1', 'done', longContent);

  assert.ok(!calls[0].includes(longContent), 'the full 500-char suggestion must not appear verbatim');
  assert.match(calls[0], /x{100,140}\.\.\./, 'the echoed content is truncated with an ellipsis');
});

test('notifySuggestionResolved swallows a DM failure rather than throwing (resolution stays the source of truth)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('DMs closed');
  });

  await assert.doesNotReject(notifySuggestionResolved(adapter, 'user-1', 'done', 'add dark mode'));
});

// notifyReportResolved holds all of resolve_report's new (issue #120)
// notification behaviour, tested directly here the same way
// notifySuggestionResolved is above.
test('notifyReportResolved sends a DM naming the outcome, wording differing per status', async () => {
  const calls: Array<[string, string]> = [];
  const adapter = stubAdapter(async (userId, text) => {
    calls.push([userId, text]);
  });

  await notifyReportResolved(adapter, 'user-1', 'resolved', 'someone was spamming the general channel');
  await notifyReportResolved(adapter, 'user-1', 'dismissed', 'someone was spamming the general channel');

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'user-1');
  assert.match(calls[0][1], /resolved/i);
  assert.match(calls[0][1], /someone was spamming the general channel/);
  assert.notEqual(calls[0][1], calls[1][1], 'resolved and dismissed get distinct wording');
});

test('notifyReportResolved keeps the dismissed-path wording neutral-to-supportive, not a bare rejection (issue #120)', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (_userId, message) => {
    calls.push(message);
  });

  await notifyReportResolved(adapter, 'user-1', 'dismissed', 'someone was spamming the general channel');

  assert.match(calls[0], /thanks/i, 'dismissed copy still acknowledges the reporter');
  assert.doesNotMatch(
    calls[0],
    /frivolous|invalid|wrong|no action needed/i,
    'dismissed copy must not imply the report was frivolous or the reporter at fault',
  );
});

test('notifyReportResolved truncates a long report reason in the echoed confirmation', async () => {
  const calls: string[] = [];
  const adapter = stubAdapter(async (_userId, message) => {
    calls.push(message);
  });
  const longReason = 'x'.repeat(500);

  await notifyReportResolved(adapter, 'user-1', 'resolved', longReason);

  assert.ok(!calls[0].includes(longReason), 'the full 500-char reason must not appear verbatim');
  assert.match(calls[0], /x{100,140}\.\.\./, 'the echoed reason is truncated with an ellipsis');
});

test('notifyReportResolved swallows a DM failure rather than throwing (resolution stays the source of truth)', async () => {
  const adapter = stubAdapter(async () => {
    throw new Error('DMs closed');
  });

  await assert.doesNotReject(notifyReportResolved(adapter, 'user-1', 'resolved', 'reason'));
});

test('SECURITY: moderation_history rejects an actionKind outside the allow-list at the zod schema boundary', () => {
  const adapter = stubAdapter(async () => {});
  const caller = {
    platform: 'discord' as const,
    userId: 'admin-1',
    userName: 'Admin',
    role: 'admin' as const,
    conversationId: 'convo-1',
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>;
    }
  )._registeredTools['moderation_history'];

  assert.equal(
    registeredTool.inputSchema.safeParse({ actionKind: 'grant_admin' }).success,
    false,
    'a privileged kind outside MODERATION_ACTION_KINDS must fail validation, never reach SQL',
  );
  for (const kind of MODERATION_ACTION_KINDS) {
    assert.equal(
      registeredTool.inputSchema.safeParse({ actionKind: kind }).success,
      true,
      `${kind} is allow-listed`,
    );
  }
  assert.equal(registeredTool.inputSchema.safeParse({}).success, true, 'actionKind stays optional');
});

// community_info (issue #92): the reply is fully determined by caller.role
// (already trusted, tier-resolved data), so the handler is exercised directly
// via the MCP server's registered tool, same pattern as the
// moderation_history zod test above — no DB, no adapter behaviour involved.
function communityInfoHandler(role: 'member' | 'admin' | 'super_admin') {
  const adapter = stubAdapter(async () => {});
  const caller = {
    platform: 'discord' as const,
    userId: 'caller-1',
    userName: 'Caller',
    role,
    conversationId: 'convo-1',
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: () => Promise<{ content: Array<{ type: string; text: string }> }> }
      >;
    }
  )._registeredTools['community_info'];
  return registeredTool.handler();
}

test('community_info names every member capability for a member caller (issue #92)', async () => {
  const result = await communityInfoHandler('member');
  const replyText = result.content[0]?.text ?? '';

  assert.match(replyText, /report/i, 'must mention report_content');
  assert.match(replyText, /forget/i, 'must mention forget_me');
  assert.match(replyText, /suggest/i, 'must mention suggest_improvement');
  assert.match(replyText, /knowledge/i, 'must mention knowledge_search');
  assert.match(replyText, /past messages|remember/i, 'must mention remember_search');
  assert.match(replyText, /simply/i, 'must mention set_response_style (issue #126) so it is discoverable');
});

test('community_info reply stays concise, not a wall of text (issue #92)', async () => {
  const result = await communityInfoHandler('member');
  const replyText = result.content[0]?.text ?? '';

  assert.ok(replyText.length < 700, `reply should stay short; was ${replyText.length} chars`);
});

test('community_info appends an admin-extras line for admin/super_admin callers, on top of the member content (issue #92)', async () => {
  const memberReply = (await communityInfoHandler('member')).content[0]?.text ?? '';
  const adminReply = (await communityInfoHandler('admin')).content[0]?.text ?? '';
  const superAdminReply = (await communityInfoHandler('super_admin')).content[0]?.text ?? '';

  assert.ok(adminReply.startsWith(memberReply), 'admin reply must include the full member content');
  assert.match(adminReply, /moderat/i, 'admin reply must note extra moderation/management capabilities');
  assert.equal(superAdminReply, adminReply, 'super_admin sees the same extras line as admin');
  assert.notEqual(adminReply, memberReply, 'admin reply must differ from the member-only reply');
});

test('SECURITY: redeploy_bot registers a pending action instead of executing directly (issue #101)', async () => {
  const adapter = stubAdapter(async () => {});
  const caller = {
    platform: 'discord' as const,
    userId: 'super-1',
    userName: 'SuperAdmin',
    role: 'super_admin' as const,
    conversationId: 'convo-redeploy',
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: object) => Promise<{ content: Array<{ type: string; text: string }> }> }
      >;
    }
  )._registeredTools['redeploy_bot'];

  assert.equal(
    hasPendingAction('discord', 'convo-redeploy', 'super-1'),
    false,
    'nothing pending before the call',
  );
  const result = await registeredTool.handler({});
  assert.match(
    result.content[0].text,
    /CONFIRM/,
    'must ask for out-of-band confirmation, not run immediately',
  );
  assert.ok(
    hasPendingAction('discord', 'convo-redeploy', 'super-1'),
    'must register a pending action rather than execute the deploy directly from the model-facing call',
  );

  cancelPendingAction('discord', 'convo-redeploy', 'super-1');
});

test('SECURITY: redeploy_bot handler refuses a direct call from an admin caller (assertAtLeast re-check)', async () => {
  const adapter = stubAdapter(async () => {});
  const caller = {
    platform: 'discord' as const,
    userId: 'admin-1',
    userName: 'Admin',
    role: 'admin' as const,
    conversationId: 'convo-redeploy-admin',
  };
  const server = buildToolServer(caller, adapter);
  const registeredTool = (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: object) => Promise<unknown> }>;
    }
  )._registeredTools['redeploy_bot'];

  await assert.rejects(() => registeredTool.handler({}), /Permission denied/);
  assert.equal(
    hasPendingAction('discord', 'convo-redeploy-admin', 'admin-1'),
    false,
    'a refused call must never register a pending action either',
  );
});

// formatKnowledgeSearchResults holds all of knowledge_search's relevance-
// filtering behaviour (issue #95) — it's exported and unit-tested directly
// here with synthetic similarity values, same rationale as
// notifyMemberApproved above: it's the exact function the handler calls
// unmodified, and testing it directly is deterministic and independent of
// the embedding model, unlike going through real embeddings end-to-end
// (which tests/knowledgeEval.test.ts already covers for ranking quality and
// for grounding KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD itself).
const fakeHit = (similarity: number, title = 'Some entry') => ({
  title,
  content: 'Some content.',
  similarity,
  updatedAt: new Date(),
});

test('formatKnowledgeSearchResults returns "no matching" when every hit is below the relevance threshold, even though hits exist', () => {
  const hits = [
    fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD - 0.01),
    fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD - 0.2),
  ];
  assert.equal(formatKnowledgeSearchResults(hits), 'No matching knowledge entries.');
});

test('formatKnowledgeSearchResults returns "no matching" for an empty hit list (table empty, unchanged behaviour)', () => {
  assert.equal(formatKnowledgeSearchResults([]), 'No matching knowledge entries.');
});

test('formatKnowledgeSearchResults keeps hits at/above the threshold and drops only the sub-threshold ones', () => {
  const relevant = fakeHit(KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD, 'Relevant entry');
  const borderlineAbove = fakeHit(0.99, 'Very relevant entry');
  const irrelevant = fakeHit(0.01, 'Irrelevant entry');
  const text = formatKnowledgeSearchResults([borderlineAbove, relevant, irrelevant]);

  assert.match(text, /Very relevant entry/);
  assert.match(text, /Relevant entry/);
  assert.doesNotMatch(text, /Irrelevant entry/);
});

test('formatKnowledgeSearchResults annotates surviving hits with an exact "(NN% match)" — same rounding/wording as remember_search', () => {
  const text = formatKnowledgeSearchResults([fakeHit(0.876, 'Rounds to 88')]);
  assert.match(text, /\(88% match\)/);
  assert.match(text, /Rounds to 88/);
});

test(
  'knowledge_search tool handler wires searchKnowledge into formatKnowledgeSearchResults end-to-end (real DB + embeddings)',
  { skip },
  async () => {
    const uniqueTitle = `Zylotrix onboarding steps ${RUN}`;
    await saveKnowledge({
      title: uniqueTitle,
      content: 'To onboard to Zylotrix, request an invite from an admin and complete the setup wizard.',
      scope: KNOWLEDGE_SEARCH_HANDLER_SCOPE,
    });

    const adapter = stubAdapter(async () => {});
    const caller = {
      platform: 'discord' as const,
      userId: 'member-1',
      userName: 'Member',
      role: 'member' as const,
      // Matches the scope the fixture entry was saved under, so this exercises
      // the in-scope (conversation-scoped) retrieval path (issue #106); the
      // out-of-scope paths are covered in tests/knowledgeScope.test.ts.
      conversationId: KNOWLEDGE_SEARCH_HANDLER_SCOPE,
    };
    const server = buildToolServer(caller, adapter);
    const registeredTool = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: { query: string }) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools['knowledge_search'];

    const result = await registeredTool.handler({ query: 'how do I get set up on Zylotrix' });
    const text = result.content[0]?.text ?? '';

    assert.match(text, /% match\)/, 'a genuinely relevant hit must surface its match percentage');
    assert.match(text, new RegExp(uniqueTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  },
);

// resolve_suggestion tool handler (issue #116): notifySuggestionResolved
// itself is unit-tested above without the MCP transport; these exercise the
// handler's wiring — the same-platform guard in particular — against a real
// resolved row, which requires the DB.
function resolveSuggestionHandler(caller: { platform: 'discord' | 'whatsapp'; adapter: PlatformAdapter }) {
  const server = buildToolServer(
    {
      platform: caller.platform,
      userId: 'admin-1',
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: 'convo-1',
    },
    caller.adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            id: number;
            status: 'reviewed' | 'declined' | 'done';
          }) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      >;
    }
  )._registeredTools['resolve_suggestion'];
}

test(
  'resolve_suggestion sends the submitter a DM when resolved on their own platform (issue #116)',
  { skip },
  async () => {
    const created = await createSuggestion({
      platform: 'discord',
      userId: RESOLVE_SUGGESTION_HANDLER_USER,
      content: 'same-platform resolution',
    });
    assert.ok(created);

    const calls: Array<[string, string]> = [];
    const adapter = stubAdapter(async (userId, text) => {
      calls.push([userId, text]);
    });

    const result = await resolveSuggestionHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'done',
    });

    assert.match(result.content[0]?.text ?? '', /marked done/);
    assert.equal(calls.length, 1, 'the submitter is notified when the admin is on the same platform');
    assert.equal(calls[0][0], RESOLVE_SUGGESTION_HANDLER_USER);
    assert.match(calls[0][1], /done/i);
  },
);

test(
  'SECURITY: resolve_suggestion sends no DM when the resolving admin is on a different platform than the suggestion (issue #116)',
  { skip },
  async () => {
    const created = await createSuggestion({
      platform: 'whatsapp',
      userId: RESOLVE_SUGGESTION_HANDLER_USER,
      content: 'cross-platform resolution must not misaddress a DM',
    });
    assert.ok(created);

    const calls: string[] = [];
    const adapter = stubAdapter(async (userId) => {
      calls.push(userId);
    });

    // The suggestion was filed on whatsapp; the admin resolving it is
    // calling from discord — sendDirectMessage must never fire, since the
    // per-turn adapter has no way to reach the whatsapp identity safely.
    const result = await resolveSuggestionHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'done',
    });

    assert.match(result.content[0]?.text ?? '', /marked done/, 'resolution itself still succeeds');
    assert.equal(calls.length, 0, 'a cross-platform resolution sends no DM');
  },
);

test(
  'resolve_suggestion sends no DM and reports failure for an unknown suggestion id (issue #116)',
  { skip },
  async () => {
    const calls: string[] = [];
    const adapter = stubAdapter(async (userId) => {
      calls.push(userId);
    });

    const result = await resolveSuggestionHandler({ platform: 'discord', adapter }).handler({
      id: 999_999_999,
      status: 'done',
    });

    assert.match(result.content[0]?.text ?? '', /Failed/);
    assert.equal(calls.length, 0, 'no row resolved means no notification');
  },
);

test(
  "resolve_suggestion's own reported outcome is unaffected by a DM delivery failure (issue #116)",
  { skip },
  async () => {
    const created = await createSuggestion({
      platform: 'discord',
      userId: RESOLVE_SUGGESTION_HANDLER_USER,
      content: 'DM will fail to send',
    });
    assert.ok(created);

    const adapter = stubAdapter(async () => {
      throw new Error('DMs closed');
    });

    const result = await resolveSuggestionHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'done',
    });

    assert.match(result.content[0]?.text ?? '', /marked done/, 'resolve_suggestion still reports success');
  },
);

// resolve_report tool handler (issue #120): notifyReportResolved itself is
// unit-tested above without the MCP transport; these exercise the handler's
// wiring — the same-platform guard in particular — against a real resolved
// row, which requires the DB. Same pattern as resolveSuggestionHandler above.
function resolveReportHandler(caller: { platform: 'discord' | 'whatsapp'; adapter: PlatformAdapter }) {
  const server = buildToolServer(
    {
      platform: caller.platform,
      userId: 'admin-1',
      userName: 'Admin',
      role: 'admin' as const,
      conversationId: 'convo-1',
    },
    caller.adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            id: number;
            status: 'resolved' | 'dismissed';
          }) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      >;
    }
  )._registeredTools['resolve_report'];
}

test(
  'resolve_report sends the reporter a DM when resolved on their own platform (issue #120)',
  { skip },
  async () => {
    const created = await createContentReport({
      platform: 'discord',
      reporterUserId: RESOLVE_REPORT_HANDLER_USER,
      conversationId: 'convo-1',
      reason: 'same-platform resolution',
    });
    assert.ok(created);

    const calls: Array<[string, string]> = [];
    const adapter = stubAdapter(async (userId, text) => {
      calls.push([userId, text]);
    });

    const result = await resolveReportHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'resolved',
    });

    assert.match(result.content[0]?.text ?? '', /marked resolved/);
    assert.equal(calls.length, 1, 'the reporter is notified when the admin is on the same platform');
    assert.equal(calls[0][0], RESOLVE_REPORT_HANDLER_USER);
    assert.match(calls[0][1], /resolved/i);
  },
);

test(
  'SECURITY: resolve_report sends no DM when the resolving admin is on a different platform than the report (issue #120)',
  { skip },
  async () => {
    const created = await createContentReport({
      platform: 'whatsapp',
      reporterUserId: RESOLVE_REPORT_HANDLER_USER,
      conversationId: 'convo-1',
      reason: 'cross-platform resolution must not misaddress a DM',
    });
    assert.ok(created);

    const calls: string[] = [];
    const adapter = stubAdapter(async (userId) => {
      calls.push(userId);
    });

    // The report was filed on whatsapp; the admin resolving it is calling
    // from discord — sendDirectMessage must never fire, since the per-turn
    // adapter has no way to reach the whatsapp identity safely.
    const result = await resolveReportHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'resolved',
    });

    assert.match(result.content[0]?.text ?? '', /marked resolved/, 'resolution itself still succeeds');
    assert.equal(calls.length, 0, 'a cross-platform resolution sends no DM');
  },
);

test(
  'resolve_report sends no DM and reports failure for an unknown report id (issue #120)',
  { skip },
  async () => {
    const calls: string[] = [];
    const adapter = stubAdapter(async (userId) => {
      calls.push(userId);
    });

    const result = await resolveReportHandler({ platform: 'discord', adapter }).handler({
      id: 999_999_999,
      status: 'resolved',
    });

    assert.match(result.content[0]?.text ?? '', /Failed/);
    assert.equal(calls.length, 0, 'no row resolved means no notification');
  },
);

test(
  "resolve_report's own reported outcome is unaffected by a DM delivery failure (issue #120)",
  { skip },
  async () => {
    const created = await createContentReport({
      platform: 'discord',
      reporterUserId: RESOLVE_REPORT_HANDLER_USER,
      conversationId: 'convo-1',
      reason: 'DM will fail to send',
    });
    assert.ok(created);

    const adapter = stubAdapter(async () => {
      throw new Error('DMs closed');
    });

    const result = await resolveReportHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'resolved',
    });

    assert.match(result.content[0]?.text ?? '', /marked resolved/, 'resolve_report still reports success');
  },
);

test(
  "SECURITY: resolve_report's notification DM never includes the reported user's identity (issue #120)",
  { skip },
  async () => {
    const targetUserId = `${RUN}-resolve-report-target`;
    const created = await createContentReport({
      platform: 'discord',
      reporterUserId: RESOLVE_REPORT_HANDLER_USER,
      conversationId: 'convo-1',
      targetUserId,
      reason: 'they were harassing me',
    });
    assert.ok(created);

    const calls: string[] = [];
    const adapter = stubAdapter(async (_userId, message) => {
      calls.push(message);
    });

    await resolveReportHandler({ platform: 'discord', adapter }).handler({
      id: created.id,
      status: 'dismissed',
    });

    assert.equal(calls.length, 1);
    assert.ok(
      !calls[0].includes(targetUserId),
      "SECURITY: the reporter's resolution DM must never include the reported user's identity",
    );
    assert.match(calls[0], /they were harassing me/, "the reporter's own reason is echoed");
  },
);

// set_response_style (issue #126): a closed two-value enum, no CONFIRM gate —
// the handler just upserts via repository.setResponseStyle, so this exercises
// the real DB round-trip, same convention as the knowledge_search handler test.
function setResponseStyleHandler(caller: { platform: 'discord' | 'whatsapp'; userId: string }) {
  const adapter = stubAdapter(async () => {});
  const server = buildToolServer(
    {
      platform: caller.platform,
      userId: caller.userId,
      userName: 'Member',
      role: 'member' as const,
      conversationId: 'convo-1',
    },
    adapter,
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: {
            style: 'standard' | 'plain';
          }) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      >;
    }
  )._registeredTools['set_response_style'];
}

test(
  "set_response_style upserts the caller's preference, readable back via getResponseStyle (issue #126)",
  { skip },
  async () => {
    const userId = `${RUN}-set-response-style-user`;

    const plainResult = await setResponseStyleHandler({ platform: 'discord', userId }).handler({
      style: 'plain',
    });
    assert.match(plainResult.content[0]?.text ?? '', /simple/i);
    assert.equal(await getResponseStyle('discord', userId), 'plain');

    const standardResult = await setResponseStyleHandler({ platform: 'discord', userId }).handler({
      style: 'standard',
    });
    assert.match(standardResult.content[0]?.text ?? '', /normal reply style/i);
    assert.equal(await getResponseStyle('discord', userId), 'standard');

    await pool.query(`DELETE FROM response_style_prefs WHERE platform = 'discord' AND user_id = $1`, [
      userId,
    ]);
  },
);
