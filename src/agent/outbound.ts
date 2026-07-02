import type { CodeAnswersPolicy } from '../storage/policies.js';

/**
 * Outbound reply filter (DLP + behaviour policy), applied to every message
 * the bot sends. The model can be sweet-talked; this filter cannot.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[\w-]{8,}\b/g, // Anthropic keys/tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // generic sk- API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[\w-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\bpostgres(?:ql)?:\/\/\S+/gi, // connection strings
];

const REDACTED = '[redacted]';
const SNIPPET_MAX_LINES = 15;

const CODE_OMITTED_NOTE =
  '_[code omitted — this assistant does not write code for the community; try claude.ai or the API directly]_';
const CODE_TRUNCATED_NOTE = (shown: number) =>
  `\n_[snippet truncated to ${shown} lines — community policy; ask on claude.ai for full programs]_`;

/**
 * Redact secrets. `knownSecrets` are exact runtime values (tokens, DB URLs)
 * that must never appear in output regardless of pattern matching.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Enforce the code_answers policy on fenced code blocks. Implemented as a
 * line walker (not a paired regex) so an UNTERMINATED fence — trivially
 * produced by a sweet-talked model or a cut-off reply — is treated as
 * running to end-of-text instead of bypassing the policy.
 */
export function applyCodePolicy(text: string, policy: CodeAnswersPolicy): string {
  if (policy === 'full') return text;

  const out: string[] = [];
  let fenceHeader: string | null = null;
  let body: string[] = [];

  const flushBlock = () => {
    if (policy === 'off') {
      out.push(CODE_OMITTED_NOTE);
    } else if (body.length <= SNIPPET_MAX_LINES) {
      out.push(fenceHeader as string, ...body, '```');
    } else {
      out.push(
        fenceHeader as string,
        ...body.slice(0, SNIPPET_MAX_LINES),
        '```' + CODE_TRUNCATED_NOTE(SNIPPET_MAX_LINES),
      );
    }
    fenceHeader = null;
    body = [];
  };

  for (const line of text.split('\n')) {
    if (fenceHeader === null) {
      if (/^\s*```/.test(line)) fenceHeader = line;
      else out.push(line);
    } else if (/^\s*```\s*$/.test(line)) {
      flushBlock();
    } else {
      body.push(line);
    }
  }
  // Unterminated fence: apply the policy to the trailing block anyway.
  if (fenceHeader !== null) flushBlock();

  return out.join('\n');
}

export function filterOutbound(
  text: string,
  policy: CodeAnswersPolicy,
  knownSecrets: readonly string[] = [],
): string {
  return applyCodePolicy(redactSecrets(text, knownSecrets), policy);
}
