import { z } from 'zod';
import type { Project } from '@swampratnz/agent-base/storage/repository.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import {
  addProjectMember,
  bindProjectSurface,
  createProject,
  getMemberRole,
  getProjectBySlug,
  TEAM_PROJECT_BRIEF_MAX_CHARS,
  TEAM_PROJECT_NAME_MAX_CHARS,
  upsertMember,
} from '@swampratnz/agent-base/storage/repository.js';
import { text } from './helpers.js';
import { notifyMemberApproved, notifyProjectMemberAdded } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Cap on `members` per call (issue #944's "capped at ~10"). Chosen to match
 * the Impact Lab's per-team roster size the proposal was written for, and
 * enforced BOTH by the zod schema below (so the SDK refuses an oversized call
 * before the handler ever runs) and again in the handler (PR #929's
 * project_note defence-in-depth precedent) so a caller that reaches the
 * handler directly — as a test does — is refused before any write too.
 */
export const TEAM_SETUP_MEMBER_CAP = 10;

/**
 * Strip a Discord `<@id>`/`<@!id>` mention wrapper down to the bare snowflake
 * so it can reach `resolveMemberTarget`'s digits-only `normalizeMemberId`
 * (issue #944's "members ... / Discord mentions"). Anything that isn't
 * EXACTLY that wrapper — including a WhatsApp number, which never looks like
 * this — passes through untouched, so this is safe to apply unconditionally.
 */
function stripDiscordMention(raw: string): string {
  const trimmed = raw.trim();
  const match = /^<@!?(\d+)>$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * Neutralise caller-supplied free text before it reaches the model-visible
 * CONFIRM description — the #227 quarantine-escape class, same character
 * class `moderate`'s delete_message preview strips (moderation.ts). Broader
 * than `requireConfirm`'s own blanket `<>\r\n`-only strip (context.ts), which
 * deliberately leaves quotes alone for legitimate labels — here the
 * interpolated text is member ids/mentions and a free-text project name, not
 * a display label, so quotes are stripped too.
 */
function sanitizeForConfirm(s: string): string {
  return s.replace(/[<>"\r\n]/g, ' ');
}

export const teamSetupTools = [
  defineTool({
    name: 'team_setup',
    description:
      'Batch-create a team project in ONE CONFIRM-gated call: create the project, register any listed ' +
      'member who is not yet a community member (member tier only, identical to add_member), add every ' +
      'listed member to the project (data access only, never tier), and bind THIS conversation as its ' +
      `surface — composing project_create + add_member + project_add_member + project_bind_here so ` +
      `standing up a team (e.g. an event roster) takes one call instead of one per step. Run it IN the ` +
      `team's own channel/group, since the binding always targets the current conversation. members is ` +
      `capped at ${TEAM_SETUP_MEMBER_CAP} platform user ids or Discord mentions. Re-running the same call ` +
      'is safe — every sub-action reports created/already existed/failed. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and hyphens')
        .describe('Short handle for the project, e.g. "impact-lab-team-3"'),
      name: z
        .string()
        .min(1)
        .max(TEAM_PROJECT_NAME_MAX_CHARS)
        .describe(`Human-readable project name (max ${TEAM_PROJECT_NAME_MAX_CHARS} characters)`),
      brief: z
        .string()
        .max(TEAM_PROJECT_BRIEF_MAX_CHARS)
        .optional()
        .describe(`Standing context about the project (max ${TEAM_PROJECT_BRIEF_MAX_CHARS} characters)`),
      members: z
        .array(z.string().min(1))
        .min(1)
        .max(TEAM_SETUP_MEMBER_CAP)
        .describe(
          `Platform user ids or Discord mentions of the team's members (1-${TEAM_SETUP_MEMBER_CAP}). ` +
            'Anyone not already a community member is registered at member tier, exactly like add_member.',
        ),
    },
    handler: async (args, { caller, audited, requireConfirm, resolveMemberTarget, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'team_setup');
      // Defence in depth alongside the zod .max() above — a caller that
      // reaches the handler directly (as a test does) must be refused before
      // any write too, mirroring project_note's belt-and-braces cap (PR #929).
      if (args.members.length > TEAM_SETUP_MEMBER_CAP) {
        return text(`Refusing: at most ${TEAM_SETUP_MEMBER_CAP} members per call.`, true);
      }

      // Resolve every member id up front — READ ONLY, no write happens before
      // CONFIRM. A malformed id is never a reason to refuse the whole batch:
      // it's dropped from the plan here and reported as a failed sub-action
      // after confirmation, the same "partial failure is visible, re-running
      // is safe" contract every other sub-action gets.
      const resolved: Array<{ platform: (typeof caller)['platform']; userId: string }> = [];
      const invalid: string[] = [];
      for (const raw of args.members) {
        try {
          resolved.push(await resolveMemberTarget(stripDiscordMention(raw)));
        } catch {
          invalid.push(raw);
        }
      }
      const uniqueTargets = [...new Map(resolved.map((t) => [`${t.platform}:${t.userId}`, t])).values()];

      if (uniqueTargets.length === 0) {
        return text(
          `Refusing: no valid member id (${invalid.map(sanitizeForConfirm).join(', ') || 'none supplied'}).`,
          true,
        );
      }

      const alreadyMemberFlags = await Promise.all(
        uniqueTargets.map((t) => getMemberRole(t.platform, t.userId).then((role) => role !== null)),
      );
      const newMemberCount = alreadyMemberFlags.filter((already) => !already).length;
      const existingProject = await getProjectBySlug(args.slug);
      const invalidNote =
        invalid.length > 0
          ? ` ${invalid.length} supplied id(s) could not be validated and will be SKIPPED: ${invalid
              .map(sanitizeForConfirm)
              .join(', ')}.`
          : '';

      return requireConfirm(
        `team_setup "${sanitizeForConfirm(args.slug)}" (${sanitizeForConfirm(args.name)}): project ` +
          `${existingProject ? 'already exists' : 'will be created'}; register ${newMemberCount} of ` +
          `${uniqueTargets.length} as new members; add ${uniqueTargets.length} to the project; bind this ` +
          `conversation to it.${invalidNote}`,
        'admin',
        async () => {
          // Audited as ONE composed action (issue #944's proposal), not one
          // row per sub-action — the member list lives in params so the
          // single audit row still records exactly who this call touched.
          const { result } = await audited({
            actionKind: 'team_setup',
            conversationId: caller.conversationId,
            params: { slug: args.slug, name: args.name, members: args.members },
            run: async () => {
              const steps: string[] = [];

              let project: Project | null = null;
              try {
                const created = await createProject({
                  slug: args.slug,
                  name: args.name,
                  brief: args.brief,
                  createdBy: caller.userId,
                });
                project = created ?? (await getProjectBySlug(args.slug));
                steps.push(
                  `project "${args.slug}": ${created ? 'created' : project ? 'already existed' : 'failed'}`,
                );
              } catch (err) {
                steps.push(
                  `project "${args.slug}": failed (${err instanceof Error ? err.message : String(err)})`,
                );
              }

              if (!project) {
                for (const raw of invalid) steps.push(`${sanitizeForConfirm(raw)}: failed (invalid id)`);
                return steps.join('\n');
              }

              // Aggregate counters for the welcome-DM note appended below (issue
              // #1065) — per-target noise would duplicate what the existing
              // registration/project rows already report, so only a summary is
              // added, mirroring add_member's single MEMBER_DM_FAILED_NOTE.
              let newRegistrationCount = 0;
              let dmFailureCount = 0;

              for (const target of uniqueTargets) {
                try {
                  const wasMember = (await getMemberRole(target.platform, target.userId)) !== null;
                  let registerNote: string;
                  if (wasMember) {
                    registerNote = 'already existed';
                  } else {
                    const finalRole = await upsertMember({
                      platform: target.platform,
                      userId: target.userId,
                      role: 'member',
                      addedBy: caller.userId,
                    });
                    registerNote = `registered as ${finalRole}`;
                    newRegistrationCount += 1;
                    // Welcome DM, mirroring add_member exactly (issue #1065): routed
                    // through the TARGET's own platform adapter, never the acting
                    // admin's current-turn one, and best-effort — notifyMemberApproved
                    // swallows its own send failures and returns false rather than
                    // throwing, so this can never fail the registration/project-add
                    // below.
                    const memberTarget = adapterFor(target.platform);
                    const dmDelivered = memberTarget
                      ? await notifyMemberApproved(memberTarget, target.userId, wasMember, target.platform)
                      : true;
                    if (!dmDelivered) dmFailureCount += 1;
                  }
                  const added = await addProjectMember(
                    project.id,
                    target.platform,
                    target.userId,
                    caller.userId,
                  );
                  // Closes the gap notifyMemberApproved's call above doesn't
                  // cover (issue #1241): the welcome DM above never names the
                  // project, and a member who was ALREADY registered before
                  // this call got no DM at all. Fires for every target on the
                  // actual "newly added to project" transition — including a
                  // brand-new registrant, who gets both the generic welcome
                  // DM and this project-naming one — and never on "already a
                  // project member", so re-running team_setup against the
                  // same team doesn't re-notify every time. Gating on `added`
                  // alone (not `wasMember && added`) is what does that
                  // de-dup work: addProjectMember returns false on a repeat
                  // call regardless of wasMember.
                  if (added) {
                    const memberTarget = adapterFor(target.platform);
                    if (memberTarget) {
                      await notifyProjectMemberAdded(
                        memberTarget,
                        target.userId,
                        target.platform,
                        project.name,
                      );
                    }
                  }
                  steps.push(
                    `${target.platform}:${target.userId}: registration ${registerNote}; project ${
                      added ? 'added' : 'already existed'
                    }`,
                  );
                } catch (err) {
                  steps.push(
                    `${target.platform}:${target.userId}: failed (${err instanceof Error ? err.message : String(err)})`,
                  );
                }
              }
              for (const raw of invalid) steps.push(`${sanitizeForConfirm(raw)}: failed (invalid id)`);
              if (dmFailureCount > 0) {
                steps.push(
                  `${dmFailureCount} of ${newRegistrationCount} new members: welcome DM not delivered`,
                );
              }

              try {
                const bound = await bindProjectSurface(
                  project.id,
                  caller.platform,
                  caller.conversationId,
                  caller.userId,
                );
                steps.push(`conversation: ${bound ? 'bound' : 'already bound'}`);
              } catch (err) {
                steps.push(`conversation: failed (${err instanceof Error ? err.message : String(err)})`);
              }

              return steps.join('\n');
            },
          });
          return result;
        },
      );
    },
  }),
];
