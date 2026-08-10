import { test } from 'node:test';
import assert from 'node:assert/strict';

// fetch_page opens the bot's only caller-driven egress surface, so these are
// mostly SECURITY: cases. They call the handler directly with a hand-built
// context — `requireConfirm` and `audited` are stubs — so nothing here needs a
// database or a network, and the assertions are about the tool's own logic
// rather than the base primitive's (which has its own suite in agent-base).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.FETCH_PAGE_ENABLED = 'true';
process.env.FETCH_PAGE_ALLOWED_HOSTS = 'docs.example.test';

const { fetchPageTools } = await import('../src/module/agent/tools/fetchPage.js');
const { COMMUNITY_TOOL_TIERS } = await import('../src/module/agent/tools/index.js');

const tool = fetchPageTools[0];

interface Captured {
  confirmDescription?: string;
  confirmTier?: string;
  auditKind?: string;
  auditParams?: Record<string, unknown>;
  ran: boolean;
}

/** A context that records what the handler asked for without performing it. */
function ctxFor(role: 'guest' | 'member' | 'admin' | 'super_admin', captured: Captured) {
  return {
    caller: {
      platform: 'discord',
      userId: `u-${Math.random().toString(36).slice(2)}`,
      userName: 'Admin',
      conversationId: 'c1',
      role,
    },
    requireConfirm: (description: string, minTier: string) => {
      captured.confirmDescription = description;
      captured.confirmTier = minTier;
      // Deliberately NOT invoking `run` — that is the point of the flow.
      return { content: [{ type: 'text' as const, text: `CONFIRM: ${description}` }], isError: false };
    },
    audited: async (input: { actionKind: string; params?: Record<string, unknown> }) => {
      captured.auditKind = input.actionKind;
      captured.auditParams = input.params;
      captured.ran = true;
      return { success: true, result: 'ok' };
    },
  } as never;
}

function fresh(): Captured {
  return { ran: false };
}

test('SECURITY: fetch_page is admin-tier — it is absent from the member and guest tool surface', () => {
  assert.equal(tool.minTier, 'admin');
  const member = COMMUNITY_TOOL_TIERS.member;
  assert.equal(
    member.some((t) => t.endsWith('fetch_page')),
    false,
    'SECURITY: a member must never be offered caller-driven egress',
  );
  const admin = COMMUNITY_TOOL_TIERS.admin;
  assert.equal(
    admin.some((t) => t.endsWith('fetch_page')),
    true,
    'and it must be registered at admin, not silently absent from every tier',
  );
});

test('SECURITY: a below-admin caller is refused by the in-handler tier assertion, not merely by surface filtering', async () => {
  for (const role of ['guest', 'member'] as const) {
    const cap = fresh();
    await assert.rejects(
      () => tool.handler({ url: 'https://docs.example.test/a' }, ctxFor(role, cap)),
      `${role} must be refused`,
    );
    assert.equal(cap.ran, false, 'SECURITY: nothing may run for a below-admin caller');
    assert.equal(cap.confirmDescription, undefined, 'and no CONFIRM may even be queued');
  }
});

test('SECURITY: nothing is fetched before CONFIRM — the handler only registers a pending action', async () => {
  const cap = fresh();
  const res = await tool.handler({ url: 'https://docs.example.test/page' }, ctxFor('admin', cap));
  assert.match(res.content[0].text, /CONFIRM/);
  assert.equal(cap.ran, false, 'SECURITY: no audited run, and therefore no request, before confirmation');
  assert.equal(cap.confirmTier, 'admin', 'the tier is re-asserted at confirm time');
});

test('SECURITY: the CONFIRM text shows the full query string — the control that survives an injection the model fell for', async () => {
  // The exfiltration shape this defends: an injection persuades the model to
  // encode conversation content into a query string. The allowlist stops it
  // leaving for an unlisted host; this makes an ON-LIST attempt visible to the
  // human being asked to approve it.
  const cap = fresh();
  const leak = 'https://docs.example.test/collect?d=SECRET-CONVERSATION-TEXT&x=2';
  await tool.handler({ url: leak }, ctxFor('admin', cap));
  assert.ok(cap.confirmDescription, 'a CONFIRM must be queued');
  assert.match(
    cap.confirmDescription,
    /\?d=SECRET-CONVERSATION-TEXT&x=2/,
    'SECURITY: the query string must be shown verbatim, never trimmed or summarised away',
  );
  assert.match(
    cap.confirmDescription,
    /anything after "\?"/,
    'and the prompt must tell the approver where to look',
  );
});

test('SECURITY: a non-https URL is refused outright, with no CONFIRM queued', async () => {
  const cap = fresh();
  const res = await tool.handler({ url: 'http://docs.example.test/a' }, ctxFor('admin', cap));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /only https/i);
  assert.equal(cap.confirmDescription, undefined, 'SECURITY: no confirmation for an unusable scheme');
});

test('an unparseable URL is refused before a human is asked to approve anything', async () => {
  const cap = fresh();
  const res = await tool.handler({ url: 'not a url' }, ctxFor('admin', cap));
  assert.equal(res.isError, true);
  assert.equal(cap.confirmDescription, undefined);
});

test('the tool is feature-flagged off unless the operator enables it', () => {
  assert.ok(tool.featureFlag, 'fetch_page must declare a feature flag');
  assert.equal(
    tool.featureFlag({ fetchPage: { enabled: false } } as never),
    false,
    'disabled config removes it from the turn surface',
  );
  assert.equal(tool.featureFlag({ fetchPage: { enabled: true } } as never), true);
});

test('SECURITY: the audit row carries the full resolved URL, so an exfiltration attempt is visible afterwards', async () => {
  // Run the confirmed path by invoking the callback requireConfirm was handed.
  let confirmed: (() => Promise<string>) | undefined;
  const cap = fresh();
  const ctx = {
    ...(ctxFor('admin', cap) as unknown as Record<string, unknown>),
    requireConfirm: (_d: string, _t: string, run: () => Promise<string>) => {
      confirmed = run;
      return { content: [{ type: 'text' as const, text: 'CONFIRM' }], isError: false };
    },
  } as never;

  const url = 'https://docs.example.test/x?token=abc';
  await tool.handler({ url }, ctx);
  assert.ok(confirmed, 'the confirm callback must have been registered');
  await confirmed();

  assert.equal(cap.auditKind, 'fetch_page');
  assert.equal(
    (cap.auditParams as { url?: string } | undefined)?.url,
    url,
    'SECURITY: the audited params must carry the exact URL fetched, query string included',
  );
});
