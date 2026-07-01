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

/** Enforce the code_answers policy on fenced code blocks. */
export function applyCodePolicy(text: string, policy: CodeAnswersPolicy): string {
  if (policy === 'full') return text;
  return text.replace(/```[^\n]*\n([\s\S]*?)```/g, (block, body: string) => {
    if (policy === 'off') return CODE_OMITTED_NOTE;
    const lines = body.replace(/\n$/, '').split('\n');
    if (lines.length <= SNIPPET_MAX_LINES) return block;
    const kept = lines.slice(0, SNIPPET_MAX_LINES).join('\n');
    const fence = block.slice(0, block.indexOf('\n') + 1); // keep the language tag
    return `${fence}${kept}\n\`\`\`${CODE_TRUNCATED_NOTE(SNIPPET_MAX_LINES)}`;
  });
}

export function filterOutbound(
  text: string,
  policy: CodeAnswersPolicy,
  knownSecrets: readonly string[] = [],
): string {
  return applyCodePolicy(redactSecrets(text, knownSecrets), policy);
}
