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

test('SECURITY: community_guidelines is member+ (read-only rules text); set_community_guidelines is admin+ only, never members or guests (issue #212)', () => {
  const readTool = 'mcp__community__community_guidelines';
  const writeTool = 'mcp__community__set_community_guidelines';

  assert.ok(MEMBER_TOOLS.includes(readTool), 'community_guidelines must be in MEMBER_TOOLS');
  assert.ok(
    !(MEMBER_TOOLS as readonly string[]).includes(writeTool),
    'set_community_guidelines must not be in MEMBER_TOOLS',
  );
  assert.ok(ADMIN_TOOLS.includes(writeTool), 'set_community_guidelines must be in ADMIN_TOOLS');
  assert.ok(
    !(SUPER_ADMIN_TOOLS as readonly string[]).includes(writeTool),
    'set_community_guidelines is content curation (like save_knowledge), not super-admin runtime control like set_policy',
  );

  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(readTool), `${role} must reach community_guidelines`);
  }
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(writeTool), `${role} must not reach set_community_guidelines`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(writeTool), `${role} must reach set_community_guidelines`);
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

test('SECURITY: my_data is member+ and strictly narrower than admin-only data tools (list_member_notes, purge_user_data) — issue #188', () => {
  const tool = 'mcp__community__my_data';
  const adminOrHigherOnlyTools = [
    'mcp__community__list_member_notes',
    'mcp__community__add_member_note',
    'mcp__community__delete_member_note',
    'mcp__community__purge_user_data',
  ];

  assert.ok(MEMBER_TOOLS.includes(tool), 'my_data must be in MEMBER_TOOLS');
  for (const t of adminOrHigherOnlyTools) {
    assert.ok(
      !(MEMBER_TOOLS as readonly string[]).includes(t),
      `${t} must never be in MEMBER_TOOLS even though my_data is`,
    );
  }
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach my_data`);
  }
  for (const role of ['guest', 'member'] as const) {
    const surface = toolsForRole(role);
    for (const t of adminOrHigherOnlyTools) {
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

test('SECURITY: catch_up is member+ (guests reach it in open mode; matches MEMBER_TOOLS) — issue #167', () => {
  const tool = 'mcp__community__catch_up';
  assert.ok(MEMBER_TOOLS.includes(tool), 'catch_up must be in MEMBER_TOOLS');
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach catch_up`);
  }
  assert.ok(
    toolsForRole('guest').includes(tool),
    'guests reach catch_up too (open mode; same as MEMBER_TOOLS)',
  );
});

test('SECURITY: react_to_message is member+ (guests reach it in open mode; matches MEMBER_TOOLS) and never lands in ADMIN_TOOLS/SUPER_ADMIN_TOOLS — issue #231', () => {
  const tool = 'mcp__community__react_to_message';
  assert.ok(MEMBER_TOOLS.includes(tool), 'react_to_message must be in MEMBER_TOOLS');
  assert.ok(!ADMIN_TOOLS.includes(tool), 'react_to_message must not be duplicated into ADMIN_TOOLS');
  assert.ok(
    !SUPER_ADMIN_TOOLS.includes(tool),
    'react_to_message must not be duplicated into SUPER_ADMIN_TOOLS',
  );
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach react_to_message`);
  }
  assert.ok(
    toolsForRole('guest').includes(tool),
    'guests reach react_to_message too (open mode; same as MEMBER_TOOLS)',
  );
});

test('SECURITY: check_status is member+ (guests reach it in open mode; matches MEMBER_TOOLS) and never lands in ADMIN_TOOLS/SUPER_ADMIN_TOOLS — issue #206', () => {
  const tool = 'mcp__community__check_status';
  assert.ok(MEMBER_TOOLS.includes(tool), 'check_status must be in MEMBER_TOOLS');
  for (const role of ['member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach check_status`);
  }
  assert.ok(
    toolsForRole('guest').includes(tool),
    'guests reach check_status too (open mode; same as MEMBER_TOOLS)',
  );
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.notEqual(t, tool, 'check_status must not appear in ADMIN_TOOLS/SUPER_ADMIN_TOOLS');
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

test('SECURITY: set_language_preference is member-tier and reaches guests in open mode (issue #189)', () => {
  const tool = 'mcp__community__set_language_preference';
  assert.ok(MEMBER_TOOLS.includes(tool), 'set_language_preference must be in MEMBER_TOOLS');
  for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.notEqual(t, tool, 'set_language_preference must not appear in ADMIN_TOOLS/SUPER_ADMIN_TOOLS');
  }
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach set_language_preference`);
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

test('SECURITY: list_knowledge_gaps is admin-only, conversation-scoped like question_digest — the below-floor knowledge_search miss signal never reaches member/guest turns (issue #208)', () => {
  const tool = 'mcp__community__list_knowledge_gaps';
  assert.ok(ADMIN_TOOLS.includes(tool), 'list_knowledge_gaps must be in ADMIN_TOOLS');
  assert.ok(
    !(MEMBER_TOOLS as readonly string[]).includes(tool),
    'list_knowledge_gaps must not be in MEMBER_TOOLS',
  );
  assert.ok(
    !(SUPER_ADMIN_TOOLS as readonly string[]).includes(tool),
    'list_knowledge_gaps must not be exclusively a SUPER_ADMIN_TOOLS entry',
  );
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach list_knowledge_gaps`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach list_knowledge_gaps`);
  }
});

test('SECURITY: create_poll is admin-tier — never reachable by member/guest (issue #228)', () => {
  const tool = 'mcp__community__create_poll';
  assert.ok(ADMIN_TOOLS.includes(tool), 'create_poll must be in ADMIN_TOOLS');
  assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(tool), 'create_poll must not be in MEMBER_TOOLS');
  assert.ok(
    !(SUPER_ADMIN_TOOLS as readonly string[]).includes(tool),
    'create_poll must not be double-listed in SUPER_ADMIN_TOOLS',
  );
  for (const role of ['guest', 'member'] as const) {
    assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach create_poll`);
  }
  for (const role of ['admin', 'super_admin'] as const) {
    assert.ok(toolsForRole(role).includes(tool), `${role} must reach create_poll`);
  }
});

test('SECURITY: create_thread / archive_thread are admin-tier — never reachable by member/guest (issue #229)', () => {
  for (const tool of ['mcp__community__create_thread', 'mcp__community__archive_thread']) {
    assert.ok(ADMIN_TOOLS.includes(tool), `${tool} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(tool), `${tool} must not be in MEMBER_TOOLS`);
    assert.ok(
      !(SUPER_ADMIN_TOOLS as readonly string[]).includes(tool),
      `${tool} must not be double-listed in SUPER_ADMIN_TOOLS`,
    );
    for (const role of ['guest', 'member'] as const) {
      assert.ok(!toolsForRole(role).includes(tool), `${role} must not reach ${tool}`);
    }
    for (const role of ['admin', 'super_admin'] as const) {
      assert.ok(toolsForRole(role).includes(tool), `${role} must reach ${tool}`);
    }
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

test('SECURITY: assign_community_role / remove_community_role / list_assignable_roles are admin-only, never members or guests (issue #232)', () => {
  const tools = [
    'mcp__community__assign_community_role',
    'mcp__community__remove_community_role',
    'mcp__community__list_assignable_roles',
  ];
  for (const t of tools) {
    assert.ok(ADMIN_TOOLS.includes(t), `${t} must be in ADMIN_TOOLS`);
    assert.ok(!(MEMBER_TOOLS as readonly string[]).includes(t), `${t} must not be in MEMBER_TOOLS`);
    assert.ok(!(SUPER_ADMIN_TOOLS as readonly string[]).includes(t), `${t} must not be super-admin-only`);
  }
  for (const role of ['guest', 'member'] as const) {
    for (const t of tools) {
      assert.ok(!toolsForRole(role).includes(t), `${role} must not reach ${t}`);
    }
  }
  for (const role of ['admin', 'super_admin'] as const) {
    for (const t of tools) {
      assert.ok(toolsForRole(role).includes(t), `${role} must reach ${t}`);
    }
  }
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
