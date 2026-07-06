import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_TOOLS,
  MEMBER_TOOLS,
  SUPER_ADMIN_TOOLS,
  assertAtLeast,
  atLeast,
  toolsForRole,
} from '../src/auth/rbac.js';

test('tier ordering', () => {
  assert.ok(atLeast('super_admin', 'admin'));
  assert.ok(atLeast('admin', 'member'));
  assert.ok(atLeast('member', 'guest'));
  assert.ok(!atLeast('member', 'admin'));
  assert.ok(!atLeast('admin', 'super_admin'));
  assert.ok(!atLeast('guest', 'member'));
});

test('SECURITY: members and guests never get admin or super-admin tools', () => {
  for (const role of ['member', 'guest'] as const) {
    const tools = toolsForRole(role);
    for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
      assert.ok(!tools.includes(t), `${role} tools must not include ${t}`);
    }
    assert.deepEqual(tools, [...MEMBER_TOOLS]);
  }
});

test('SECURITY: whats_new is admin-only (binding requirement from #55)', () => {
  const tool = 'mcp__community__whats_new';
  assert.ok(ADMIN_TOOLS.includes(tool), 'whats_new must be in ADMIN_TOOLS');
  assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(tool), 'whats_new must not be in MEMBER_TOOLS');
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach whats_new`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach whats_new`);
  }
});

test('SECURITY: generate_image is admin/super-admin only, never members or guests', () => {
  const tool = 'mcp__community__generate_image';
  assert.ok(ADMIN_TOOLS.includes(tool), 'generate_image must be in ADMIN_TOOLS');
  assert.ok(
    !(MEMBER_TOOLS as readonly string[]).includes(tool),
    'generate_image must not be in MEMBER_TOOLS',
  );
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach generate_image`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach generate_image`);
  }
});

test('SECURITY: report_content is member+ (guests never get it in gated mode; matches MEMBER_TOOLS)', () => {
  const tool = 'mcp__community__report_content';
  assert.ok(MEMBER_TOOLS.includes(tool), 'report_content must be in MEMBER_TOOLS');
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach report_content`);
  }
});

test('SECURITY: withdraw_report is member+ (retract your own report; scoping to own reports is enforced in SQL)', () => {
  const tool = 'mcp__community__withdraw_report';
  assert.ok(MEMBER_TOOLS.includes(tool), 'withdraw_report must be in MEMBER_TOOLS');
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach withdraw_report`);
  }
});

test('SECURITY: my_submissions is member+ and strictly narrower than the shared queue tools (list_suggestions/list_reports, both admin-only)', () => {
  const tool = 'mcp__community__my_submissions';
  const sharedQueueTools = ['mcp__community__list_suggestions', 'mcp__community__list_reports'];

  assert.ok(MEMBER_TOOLS.includes(tool), 'my_submissions must be in MEMBER_TOOLS');
  for (const t of sharedQueueTools) {
    assert.ok(
      !(MEMBER_TOOLS as readonly string[]).includes(t),
      `${t} (the shared queue) must never be in MEMBER_TOOLS even though my_submissions is`,
    );
  }
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach my_submissions`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of sharedQueueTools) {
      assert.ok(!surface.includes(t), `${role} must not reach the shared queue via ${t}`);
    }
  }
});

test('SECURITY: my_warnings is member+ and strictly narrower than the admin-only moderation tools (clear_warnings/moderation_history)', () => {
  const tool = 'mcp__community__my_warnings';
  const adminOnlyModerationTools = ['mcp__community__clear_warnings', 'mcp__community__moderation_history'];

  assert.ok(MEMBER_TOOLS.includes(tool), 'my_warnings must be in MEMBER_TOOLS');
  for (const t of adminOnlyModerationTools) {
    assert.ok(
      !(MEMBER_TOOLS as readonly string[]).includes(t),
      `${t} must never be in MEMBER_TOOLS even though my_warnings is`,
    );
  }
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach my_warnings`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of adminOnlyModerationTools) {
      assert.ok(!surface.includes(t), `${role} must not reach ${t}`);
    }
  }
});

test('SECURITY: rate_answer is member+ (guests never get it in gated mode; matches MEMBER_TOOLS)', () => {
  const tool = 'mcp__community__rate_answer';
  assert.ok(MEMBER_TOOLS.includes(tool), 'rate_answer must be in MEMBER_TOOLS');
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach rate_answer`);
  }
});

test('SECURITY: list_answer_feedback is admin-only — a member can never read the aggregate rating queue, including ratings they themselves submitted (issue #118)', () => {
  const tool = 'mcp__community__list_answer_feedback';
  assert.ok(ADMIN_TOOLS.includes(tool), 'list_answer_feedback must be in ADMIN_TOOLS');
  assert.ok(
    !(MEMBER_TOOLS as readonly string[]).includes(tool),
    'list_answer_feedback must not be in MEMBER_TOOLS',
  );
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach list_answer_feedback`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach list_answer_feedback`);
  }
});

test('SECURITY: list_reports and resolve_report are admin-only (member/guest must never reach them)', () => {
  const tools = ['mcp__community__list_reports', 'mcp__community__resolve_report'];
  for (const t of tools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(!surface.includes(t), `${role} must not reach ${t}`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(surface.includes(t), `${role} must reach ${t}`);
  }
});

test('SECURITY: list_roster is admin-only — members/guests never see the roster (issue #47)', () => {
  const tool = 'mcp__community__list_roster';
  assert.ok(ADMIN_TOOLS.includes(tool), 'list_roster must be in ADMIN_TOOLS');
  assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(tool), 'list_roster must not be in MEMBER_TOOLS');
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach list_roster`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach list_roster`);
  }
});

test('SECURITY: suggest_improvement is write-only at member tier — the suggestion queue is only readable by admin+ (issue #46)', () => {
  const writeTool = 'mcp__community__suggest_improvement';
  const readTools = ['mcp__community__list_suggestions', 'mcp__community__resolve_suggestion'];

  assert.ok(MEMBER_TOOLS.includes(writeTool), 'suggest_improvement must be in MEMBER_TOOLS');
  for (const t of readTools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of readTools) {
      assert.ok(!surface.includes(t), `${role} must not read any suggestion (theirs or others') via ${t}`);
    }
  }
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(writeTool), `${role} must reach suggest_improvement`);
  }
});

test('SECURITY: set_response_style is member-tier and reaches guests in open mode (issue #126)', () => {
  const tool = 'mcp__community__set_response_style';
  assert.ok(MEMBER_TOOLS.includes(tool), 'set_response_style must be in MEMBER_TOOLS');
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.notEqual(t, tool, 'set_response_style must not appear in ADMIN_TOOLS/SUPER_ADMIN_TOOLS');
  }
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach set_response_style`);
  }
});

test('SECURITY: member-note tools are admin-only — a member can never read or write notes, including about themselves (issue #45)', () => {
  const tools = [
    'mcp__community__add_member_note',
    'mcp__community__list_member_notes',
    'mcp__community__delete_member_note',
  ];
  for (const t of tools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(!surface.includes(t), `${role} must not reach ${t}`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(surface.includes(t), `${role} must reach ${t}`);
  }
});

test('SECURITY: link_member and unlink_member are admin-only, never reachable by member/guest — the only way person_id can change is this explicit, CONFIRM-gated admin tool, never message content (issue #44)', () => {
  const tools = ['mcp__community__link_member', 'mcp__community__unlink_member'];
  for (const t of tools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(!surface.includes(t), `${role} must not reach ${t}`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(surface.includes(t), `${role} must reach ${t}`);
  }
});

test('SECURITY: list_context_digests is admin-only — digests derive from member content and never reach member turns (issue #51)', () => {
  const tool = 'mcp__community__list_context_digests';
  assert.ok(ADMIN_TOOLS.includes(tool), 'list_context_digests must be in ADMIN_TOOLS');
  assert.ok(
    !(MEMBER_TOOLS as readonly string[]).includes(tool),
    'list_context_digests must not be in MEMBER_TOOLS',
  );
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach list_context_digests`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach list_context_digests`);
  }
});

test('SECURITY: list_knowledge_candidates/accept_knowledge_candidate/decline_knowledge_candidate are admin-only — the review queue never reaches member/guest turns (issue #102)', () => {
  const tools = [
    'mcp__community__list_knowledge_candidates',
    'mcp__community__accept_knowledge_candidate',
    'mcp__community__decline_knowledge_candidate',
  ];
  for (const t of tools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(!surface.includes(t), `${role} must not reach ${t}`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    const surface = toolsForRole(role);
    for (const t of tools) assert.ok(surface.includes(t), `${role} must reach ${t}`);
  }
});

test('SECURITY: redeploy_bot is super-admin only (issue #101) — never reachable by admin/member/guest', () => {
  const tool = 'mcp__community__redeploy_bot';
  assert.ok(SUPER_ADMIN_TOOLS.includes(tool), 'redeploy_bot must be in SUPER_ADMIN_TOOLS');
  assert.ok(!(ADMIN_TOOLS as readonly string[]).includes(tool), 'redeploy_bot must not be in ADMIN_TOOLS');
  assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(tool), 'redeploy_bot must not be in MEMBER_TOOLS');
  for (const role of ['guest', 'member', 'admin'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach redeploy_bot`);
  }
  assert.ok(toolsForRole('super_admin').includes(tool), 'super_admin must reach redeploy_bot');
});

test('SECURITY: admins never get super-admin tools', () => {
  const tools = toolsForRole('admin');
  for (const t of SUPER_ADMIN_TOOLS) {
    assert.ok(!tools.includes(t), `admin tools must not include ${t}`);
  }
  for (const t of [...MEMBER_TOOLS, ...ADMIN_TOOLS]) {
    assert.ok(tools.includes(t), `admin tools must include ${t}`);
  }
});

test('super admin gets the full surface', () => {
  const tools = toolsForRole('super_admin');
  for (const t of [...MEMBER_TOOLS, ...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(tools.includes(t), `super_admin tools must include ${t}`);
  }
});

test('assertAtLeast enforces the hierarchy', () => {
  assert.throws(() => assertAtLeast('member', 'admin', 'announce'), /Permission denied/);
  assert.throws(() => assertAtLeast('admin', 'super_admin', 'grant_admin'), /Permission denied/);
  assert.doesNotThrow(() => assertAtLeast('admin', 'admin', 'announce'));
  assert.doesNotThrow(() => assertAtLeast('super_admin', 'admin', 'announce'));
});
