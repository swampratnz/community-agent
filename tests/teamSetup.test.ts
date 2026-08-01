import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAdapter } from '../src/platforms/types.js';

// config.ts validates env at import time — provide a dummy environment before
// anything that (transitively) loads it. Same shape as tests/findHelperTools.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const hasDb = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL.includes('test:test');
const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { buildToolServer } = await import('../src/agent/tools.js');
const { toolsForRole } = await import('../src/auth/rbac.js');
const { hasPendingAction, takePendingAction } = await import('../src/agent/pendingActions.js');
const {
  archiveProject,
  createProject,
  getMemberRole,
  getProjectBySlug,
  listProjectMembers,
  listProjectSurfaces,
  upsertMember,
} = await import('../src/storage/repository.js');
const { pool, closeDb } = await import('../src/storage/db.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
/**
 * Digits-only, 17-20 char Discord-snowflake-shaped id, unique per test run.
 * A fixed-length prefix (rather than the variable-length RUN, whose random
 * suffix can itself run up to 6 digits) so the tag always survives the final
 * slice regardless of how long that suffix happened to be this run.
 */
const ID_PREFIX = `${Date.now()}`.slice(-10);
function memberId(tag: string): string {
  return `${ID_PREFIX}${tag}`.padEnd(17, '0').slice(0, 19);
}

after(async () => {
  if (hasDb) {
    await pool.query(`DELETE FROM projects WHERE slug LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM community_users WHERE platform_user_id LIKE $1`, [`${ID_PREFIX}%`]);
    await pool.query(`DELETE FROM admin_audit WHERE action_kind = 'team_setup' AND actor_user_id LIKE $1`, [
      `${RUN}%`,
    ]);
  }
  await closeDb();
});

type TeamSetupArgs = { slug: string; name: string; brief?: string; members: string[] };
type TeamSetupHandler = (
  args: TeamSetupArgs,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function stubAdapter(): PlatformAdapter {
  return {
    platform: 'discord',
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    sendMessage: async () => {},
    sendDirectMessage: async () => {},
    conversationsForUser: async () => [],
    adminCapabilities: new Set(),
    performAdminAction: async () => {
      throw new Error('not implemented in stub');
    },
  };
}

function teamSetupHandler(caller: {
  role?: 'member' | 'guest' | 'admin' | 'super_admin';
  userId?: string;
  conversationId?: string;
}) {
  const server = buildToolServer(
    {
      platform: 'discord',
      userId: caller.userId ?? `${RUN}-admin`,
      userName: 'Admin',
      role: caller.role ?? 'admin',
      conversationId: caller.conversationId ?? `convo-${RUN}`,
      isDirect: false,
    },
    stubAdapter(),
  );
  return (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: TeamSetupHandler }>;
    }
  )._registeredTools['team_setup'];
}

test('SECURITY: team_setup refuses a below-admin caller, and is absent from the member/guest tool surface (issue #944)', async () => {
  for (const role of ['member', 'guest'] as const) {
    assert.ok(
      !toolsForRole(role).includes('mcp__community__team_setup'),
      `${role} tier's tool surface must not include team_setup`,
    );
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(
      toolsForRole(role).includes('mcp__community__team_setup'),
      `${role} tier's tool surface must include team_setup`,
    );
  }
  const conversationId = `convo-${RUN}-refuse-tier`;
  for (const role of ['member', 'guest'] as const) {
    await assert.rejects(
      () =>
        teamSetupHandler({ role, conversationId }).handler({
          slug: `${RUN}-refused`,
          name: 'Refused Team',
          members: [],
        }),
      /Permission denied/,
      `${role} must be refused at the runtime tier re-check even if it somehow reached the handler`,
    );
    assert.equal(
      hasPendingAction('discord', conversationId, `${RUN}-admin`),
      false,
      'a refused call must never register a pending action',
    );
  }
});

test(
  'SECURITY: team_setup performs zero writes before CONFIRM — it only registers a pending action (issue #944)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-no-write-before-confirm`;
    const slug = `${RUN}-noconfirm`;
    const members = [memberId('101'), memberId('102')];
    const result = await teamSetupHandler({ conversationId }).handler({
      slug,
      name: 'No Confirm Yet',
      members,
    });
    assert.match(
      result.content[0].text,
      /CONFIRM/,
      'must ask for out-of-band confirmation, not run immediately',
    );
    assert.equal(await getProjectBySlug(slug), null, 'the project must not exist before CONFIRM');
    for (const id of members) {
      assert.equal(await getMemberRole('discord', id), null, 'no member may be registered before CONFIRM');
    }
    const pending = takePendingAction('discord', conversationId, `${RUN}-admin`);
    assert.ok(pending, 'a pending action must be registered');
  },
);

test(
  'team_setup composes create + register + add + bind in one confirmed call, and re-running the identical call is idempotent (issue #944 acceptance criteria)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-happy-path`;
    const slug = `${RUN}-happy`;
    const preExisting = memberId('201');
    const fresh = [memberId('202'), memberId('203')];
    await upsertMember({ platform: 'discord', userId: preExisting, role: 'member', addedBy: 'test' });

    const handler = teamSetupHandler({ conversationId });
    const args: TeamSetupArgs = {
      slug,
      name: 'Happy Path Team',
      brief: 'A team set up in one call',
      members: [preExisting, ...fresh],
    };

    const confirmReply = await handler.handler(args);
    assert.match(confirmReply.content[0].text, /CONFIRM/);
    assert.match(
      confirmReply.content[0].text,
      /register 2 of 3/,
      'the CONFIRM description must echo how many of the listed members are actually new',
    );

    const pending = takePendingAction('discord', conversationId, `${RUN}-admin`);
    assert.ok(pending, 'must register a pending action');
    const firstReport = await pending?.execute();
    assert.match(firstReport ?? '', /project .* created/);
    assert.match(firstReport ?? '', new RegExp(`member ${fresh[0]} registration: created`));
    assert.match(firstReport ?? '', new RegExp(`member ${preExisting} registration: already existed`));
    assert.match(firstReport ?? '', /surface: created/);

    const project = await getProjectBySlug(slug);
    assert.ok(project, 'the project row must exist');
    assert.equal(project.name, 'Happy Path Team');

    const projectMembers = await listProjectMembers(project.id);
    assert.deepEqual(
      new Set(projectMembers.map((m) => m.userId)),
      new Set([preExisting, ...fresh]),
      'every listed member must be added to the project',
    );

    for (const id of fresh) {
      assert.equal(await getMemberRole('discord', id), 'member', 'a newly listed member must be registered');
    }

    const surfaces = await listProjectSurfaces(project.id);
    assert.ok(
      surfaces.some((s) => s.platform === 'discord' && s.conversationId === conversationId),
      'the calling conversation must be bound as a surface',
    );

    // Re-run the IDENTICAL call end to end: confirm again, execute again.
    const secondConfirm = await handler.handler(args);
    assert.match(secondConfirm.content[0].text, /register 0 of 3/, 'nobody is new on the second run');
    const secondPending = takePendingAction('discord', conversationId, `${RUN}-admin`);
    const secondReport = await secondPending?.execute();
    assert.match(secondReport ?? '', /project .* already existed/);
    for (const id of [preExisting, ...fresh]) {
      assert.match(secondReport ?? '', new RegExp(`member ${id} registration: already existed`));
      assert.match(secondReport ?? '', new RegExp(`member ${id} project access: already existed`));
    }
    assert.match(secondReport ?? '', /surface: already existed/);

    const projectMembersAfter = await listProjectMembers(project.id);
    assert.equal(projectMembersAfter.length, projectMembers.length, 'no duplicate project-membership rows');
    const surfacesAfter = await listProjectSurfaces(project.id);
    assert.equal(surfacesAfter.length, surfaces.length, 'no duplicate surface-binding rows');
  },
);

test(
  'team_setup refuses a call exceeding the member cap before any write (issue #944 acceptance criteria)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-cap`;
    const slug = `${RUN}-cap`;
    const tooMany = Array.from({ length: 11 }, (_, i) => memberId(`3${i}`));
    const result = await teamSetupHandler({ conversationId }).handler({
      slug,
      name: 'Over Cap Team',
      members: tooMany,
    });
    assert.match(result.content[0].text, /exceeds the cap/i);
    assert.equal(result.isError, true);
    assert.equal(await getProjectBySlug(slug), null, 'no project may be created for a refused over-cap call');
    assert.equal(
      hasPendingAction('discord', conversationId, `${RUN}-admin`),
      false,
      'an over-cap call must never register a pending action',
    );
  },
);

test(
  'SECURITY: team_setup grants data scope only — a member it registers or adds receives no tier change (issue #944 / #927 invariant)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-tier`;
    const slug = `${RUN}-tier`;
    const existingAdmin = memberId('401');
    const brandNew = memberId('402');
    await upsertMember({ platform: 'discord', userId: existingAdmin, role: 'admin', addedBy: 'test' });

    const handler = teamSetupHandler({ conversationId });
    await handler.handler({ slug, name: 'Tier Team', members: [existingAdmin, brandNew] });
    const pending = takePendingAction('discord', conversationId, `${RUN}-admin`);
    await pending?.execute();

    assert.equal(
      await getMemberRole('discord', existingAdmin),
      'admin',
      'team_setup must never downgrade an existing admin to member',
    );
    assert.equal(
      await getMemberRole('discord', brandNew),
      'member',
      'a brand-new registration must land at member tier only, never higher',
    );
  },
);

test(
  'SECURITY: team_setup discloses a slug collision with an unrelated pre-existing project honestly in the ' +
    'CONFIRM text, before any member is added to it (issue #944)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-collision`;
    const slug = `${RUN}-collision`;
    const otherAdmin = `${RUN}-other-admin`;
    const unrelatedProject = await createProject({
      slug,
      name: 'Somebody Else Project',
      createdBy: otherAdmin,
    });
    assert.ok(unrelatedProject, 'setup: the unrelated project must exist before the colliding call');

    const members = [memberId('601')];
    const handler = teamSetupHandler({ conversationId });
    const confirmReply = await handler.handler({
      slug,
      name: 'My New Team',
      members,
    });

    assert.match(confirmReply.content[0].text, /CONFIRM/);
    assert.match(
      confirmReply.content[0].text,
      /reuse the EXISTING project "Somebody Else Project"/,
      'the confirmation must name the actual existing project, not claim it will "create" one',
    );
    assert.doesNotMatch(
      confirmReply.content[0].text,
      /create project "My New Team"/,
      'the confirmation must not claim to create a project when the slug already belongs to one',
    );
    assert.match(
      confirmReply.content[0].text,
      /differs from the requested "My New Team"/,
      'the confirmation must flag that the existing name differs from the requested one',
    );

    // Confirm and execute: no member may reach the pre-existing project
    // until the admin has seen and approved that honest disclosure.
    assert.equal(
      (await listProjectMembers(unrelatedProject.id)).length,
      0,
      'no member may be added before CONFIRM even when the slug already resolves to a project',
    );
    const pending = takePendingAction('discord', conversationId, `${RUN}-admin`);
    const report = await pending?.execute();
    assert.match(report ?? '', /project .* already existed/);

    const projectAfter = await getProjectBySlug(slug);
    assert.equal(projectAfter?.name, 'Somebody Else Project', 'the existing project must not be renamed');
    const projectMembers = await listProjectMembers(unrelatedProject.id);
    assert.deepEqual(
      new Set(projectMembers.map((m) => m.userId)),
      new Set(members),
      'members are added to the existing (reused) project, exactly as disclosed',
    );
  },
);

test(
  'SECURITY: team_setup is audited as one row whose params carry the full member list (issue #944 acceptance criteria)',
  { skip },
  async () => {
    const conversationId = `convo-${RUN}-audit`;
    const slug = `${RUN}-audit`;
    const actor = `${RUN}-audit-admin`;
    const members = [memberId('501'), memberId('502')];
    const handler = teamSetupHandler({ conversationId, userId: actor });
    await handler.handler({ slug, name: 'Audit Team', members });
    const pending = takePendingAction('discord', conversationId, actor);
    await pending?.execute();

    const { rows } = await pool.query(
      `SELECT params, success FROM admin_audit WHERE action_kind = 'team_setup' AND actor_user_id = $1`,
      [actor],
    );
    assert.equal(rows.length, 1, 'exactly one audit row for the composed action');
    assert.equal(rows[0].success, true);
    assert.equal(rows[0].params.slug, slug);
    assert.deepEqual(rows[0].params.members, members, 'the audit params must carry the full member list');
  },
);

test(
  'SECURITY: team_setup discloses in the CONFIRM that the slug resolves to an ARCHIVED project — every ' +
    'step would report success while the team can reach nothing (issue #944)',
  { skip },
  async () => {
    // Sibling of the slug-collision test above, and the same principle: state
    // that changes what the admin is agreeing to belongs in the plan, not in a
    // note after the writes.
    //
    // Archived is the nastier case of the two. A collision at least reports
    // something the admin might notice; an archived reuse reports
    // created/added/bound on EVERY line — nothing refuses on an archived
    // project — and the team still cannot reach it, because visibleProjectIds
    // excludes archived projects from every read path. A silent success is
    // exactly the outcome a CONFIRM exists to prevent.
    const conversationId = `convo-${RUN}-archived`;
    const slug = `${RUN}-archived`;
    const project = await createProject({
      slug,
      name: 'Finished Team',
      createdBy: `${RUN}-other-admin`,
    });
    assert.ok(project, 'setup: the project must exist before it is archived');
    assert.equal(await archiveProject(slug), true, 'setup: the project must actually be archived');

    const handler = teamSetupHandler({ conversationId });
    const confirmReply = await handler.handler({
      slug,
      name: 'Finished Team',
      members: [memberId('701')],
    });

    const confirmText = confirmReply.content[0].text;
    assert.match(confirmText, /CONFIRM/);
    assert.match(
      confirmText,
      /ARCHIVED/,
      'the confirmation must say the project is archived BEFORE the admin approves adding a team to it',
    );
    assert.match(
      confirmText,
      /project_unarchive/,
      'and must name the remedy, so the admin can act on the warning rather than just be alarmed by it',
    );

    // The disclosure must not have cost the honesty the collision test pins:
    // this is still a reuse, and must still not claim to create anything.
    assert.doesNotMatch(
      confirmText,
      /create project "Finished Team"/,
      'an archived project is still an EXISTING one — the confirmation must not claim to create it',
    );
    assert.equal(
      (await listProjectMembers(project.id)).length,
      0,
      'and still nothing is written before CONFIRM',
    );
  },
);
