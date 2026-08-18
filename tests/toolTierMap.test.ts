import { test } from 'node:test';
import assert from 'node:assert/strict';

// The tier map, pinned exactly (issue: post-agent-base-split governance).
//
// WHY THIS FILE EXISTS, and why it is a snapshot rather than a property test:
//
// `src/module/agent/tools/index.ts` decides which tier may call which tool. A
// one-word edit there — 'admin' -> 'member' on a single entry — widens the
// privileged surface, and it typechecks, and it passes every other test in the
// suite. The existing SECURITY: cases in tests/agentOptions.test.ts assert
// CONSISTENCY ("allowedTools tracks toolsForRole exactly, no drift"), which a
// tier move preserves: both sides move together and agree. Per-tool guards
// exist only for tools someone happened to write a case for.
//
// The obvious alternative was to route the file to a mandatory human merge via
// the auto-merge governance list. Measured against the last 40 merges, that
// file appears in 62% of them (every new tool must register a tier), versus 8%
// for the manifest — governing it would have sent most feature work to a human
// press and gutted the auto-merge loop. This snapshot buys the same protection
// at zero throughput cost: a tier change cannot pass CI without editing the
// expected map in the SAME PR, so a silent widening becomes a reviewable diff
// that the PR-review loop, the adversarial pass and a human all see.
//
// MAINTENANCE: adding a tool means adding one line here. That is the intended
// friction, not an accident — the diff is the audit trail. Regenerate with
// `npx tsx tests/dumpToolTiers.ts` if the list drifts wholesale.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { COMMUNITY_TOOL_TIERS } = await import('../src/module/agent/tools/index.js');

/** Authored tier registration, prefixes stripped, sorted. */
const EXPECTED: Record<string, readonly string[]> = {
  member: [
    'appeal_moderation',
    'catch_up',
    'check_status',
    'community_digest',
    'community_guidelines',
    'community_info',
    'find_helper',
    'forget_me',
    'knowledge_search',
    'list_events',
    'list_knowledge_topics',
    'list_projects',
    'my_data',
    'my_submissions',
    'my_warnings',
    'project_list',
    'project_note',
    'project_recall',
    'rate_answer',
    'react_to_message',
    'remember_search',
    'report_content',
    'request_human_help',
    'request_project_connection',
    'set_helper_availability',
    'set_language_preference',
    'set_my_interests',
    'set_response_style',
    'share_project',
    'suggest_improvement',
    'suggest_knowledge',
    'who_is_into',
    'withdraw_knowledge_tip',
    'withdraw_report',
  ],
  admin: [
    'accept_knowledge_candidate',
    'add_member',
    'add_member_note',
    'admin_digest',
    'announce',
    'archive_thread',
    'assign_community_role',
    'cancel_event',
    'clear_warnings',
    'create_event',
    'create_poll',
    'create_thread',
    'decline_access_request',
    'decline_knowledge_candidate',
    'delete_knowledge',
    'delete_member_note',
    'end_poll',
    'fetch_page',
    'generate_image',
    'link_member',
    'list_access_requests',
    'list_answer_feedback',
    'list_appeals',
    'list_assignable_roles',
    'list_blocked_members',
    'list_context_digests',
    'list_duplicate_knowledge',
    'list_knowledge',
    'list_knowledge_candidates',
    'list_knowledge_conflicts',
    'list_knowledge_gaps',
    'list_low_rated_knowledge',
    'list_member_notes',
    'list_member_warnings',
    'list_muted_members',
    'list_reports',
    'list_roster',
    'list_suggestions',
    'list_unhelpful_themes',
    'merge_knowledge',
    'moderate',
    'moderation_history',
    'project_add_member',
    'project_archive',
    'project_bind_here',
    'project_create',
    'project_info',
    'project_remove_member',
    'project_unarchive',
    'project_unbind_here',
    'question_digest',
    'remove_community_role',
    'remove_member',
    'resolve_appeal',
    'resolve_report',
    'resolve_suggestion',
    'response_latency',
    'review_queue',
    'save_knowledge',
    'set_community_guidelines',
    'set_welcome_message',
    'team_setup',
    'unlink_member',
    'update_knowledge',
    'user_history',
    'whats_new',
  ],
  superAdmin: [
    'admin_activity',
    'audit_view',
    'dev_team_backlog',
    'dev_team_dispatch',
    'dev_team_findings',
    'dev_team_result',
    'dev_team_status',
    'dev_team_verify',
    'engagement_stats',
    'feature_flags',
    'grant_admin',
    'list_admins',
    'pause_bot',
    'purge_user_data',
    'redeploy_bot',
    'resume_bot',
    'revoke_admin',
    'set_policy',
    'suggest_issue',
    'usage_stats',
  ],
  discordOnly: [
    'archive_thread',
    'assign_community_role',
    'cancel_event',
    'create_event',
    'create_poll',
    'create_thread',
    'end_poll',
    'list_assignable_roles',
    'list_events',
    'remove_community_role',
  ],
};

const strip = (t: string) => t.replace('mcp__community__', '');

test('SECURITY: the tool tier map is exactly as pinned — no tool silently changes tier, and no tool joins a tier undeclared', () => {
  for (const key of ['member', 'admin', 'superAdmin', 'discordOnly'] as const) {
    const actual = [...COMMUNITY_TOOL_TIERS[key]].map(strip).sort();
    const expected = [...EXPECTED[key]].sort();

    const added = actual.filter((t) => !expected.includes(t));
    const removed = expected.filter((t) => !actual.includes(t));
    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      `tier '${key}' changed. If this is intentional, update EXPECTED in the same PR — that diff IS the ` +
        `review record for a privilege change. Added: [${added.join(', ')}]  Removed: [${removed.join(', ')}]`,
    );
  }
});

test('SECURITY: no tool appears in more than one tier list — a duplicate would make the effective tier depend on lookup order', () => {
  const seen = new Map<string, string>();
  for (const key of ['member', 'admin', 'superAdmin'] as const) {
    for (const raw of COMMUNITY_TOOL_TIERS[key]) {
      const t = strip(raw);
      assert.equal(seen.has(t), false, `${t} is in both '${seen.get(t)}' and '${key}'`);
      seen.set(t, key);
    }
  }
});
