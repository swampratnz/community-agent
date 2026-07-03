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

/**
 * Rewrite em dashes into natural punctuation. The system prompt asks the model
 * not to use them; this guarantees none reach the community even when it
 * disobeys. Targets the em dash (U+2014) and horizontal bar (U+2015) only —
 * the en dash (U+2013) is left alone so numeric ranges like "10–20" survive.
 */
export function stripEmDashes(line: string): string {
  return line
    .replace(/\s*[—―]\s*/g, ', ') // "a — b" / "a—b" -> "a, b"
    .replace(/\s+,/g, ',') // tidy stray space-before-comma
    .replace(/,\s*,/g, ',') // collapse doubled commas
    .replace(/,\s*([.!?;:])/g, '$1'); // "word, ." -> "word."
}

/** Apply {@link stripEmDashes} to prose only, leaving fenced code blocks untouched. */
export function stripEmDashesOutsideCode(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : stripEmDashes(line);
    })
    .join('\n');
}

const BOLD_TRIPLE = /\*\*\*(.+?)\*\*\*/g;
const UNDERSCORE_TRIPLE = /___(.+?)___/g;
const BOLD_DOUBLE = /\*\*(.+?)\*\*/g;
const UNDERSCORE_DOUBLE = /__(.+?)__/g;
const HEADING_LINE = /^(\s*)#{1,6}\s+(.*)$/;
const BULLET_LINE = /^(\s*)[-*]\s+(.*)$/;

function convertInlineEmphasis(line: string): string {
  return line
    .replace(BOLD_TRIPLE, '*$1*')
    .replace(UNDERSCORE_TRIPLE, '*$1*')
    .replace(BOLD_DOUBLE, '*$1*')
    .replace(UNDERSCORE_DOUBLE, '*$1*');
}

/**
 * Rewrite Discord/GFM-flavoured markdown into WhatsApp-readable formatting:
 * `**bold**`/`__bold__` -> `*bold*`, `# Heading` -> `*Heading*`, `- item`/`* item`
 * bullets -> `• item`. Line-anchored and fence-aware (same walker style as
 * {@link stripEmDashesOutsideCode}) so code blocks and inline `*`/`#` in prose
 * are never touched. Idempotent: re-running on already-converted text is a no-op.
 */
export function convertMarkdownForWhatsApp(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      const heading = line.match(HEADING_LINE);
      if (heading) return `${heading[1]}*${convertInlineEmphasis(heading[2])}*`;

      const emphasised = convertInlineEmphasis(line);
      const bullet = emphasised.match(BULLET_LINE);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;

      return emphasised;
    })
    .join('\n');
}

export type OutboundPlatform = 'discord' | 'whatsapp';

export function filterOutbound(
  text: string,
  policy: CodeAnswersPolicy,
  knownSecrets: readonly string[] = [],
  platform?: OutboundPlatform,
): string {
  const filtered = stripEmDashesOutsideCode(applyCodePolicy(redactSecrets(text, knownSecrets), policy));
  return platform === 'whatsapp' ? convertMarkdownForWhatsApp(filtered) : filtered;
}
