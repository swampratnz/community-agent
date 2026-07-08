// GitHub issue creation for the super-admin `suggest_issue` tool.
//
// This is the bot's ONLY GitHub egress and the only write credential it holds.
// `config.github.token` must be a FINE-GRAINED PAT scoped to `Issues: write` on
// `config.github.repo` ONLY (never the CLAUDE_CODE_OAUTH_TOKEN) — so a bot
// compromise is bounded to filing issues on one repo. See docs/SECURITY.md §
// "GitHub issue filing" and docs/DEPLOYMENT.md for how to mint it.
import { config } from '../config.js';

export interface CreatedIssue {
  number: number;
  url: string;
}

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Create an issue on the configured repo. Throws on a non-2xx response (the
 * caller audits + surfaces the message); never logs or returns the token, and
 * caps any echoed error detail so a GitHub response can't blow up a chat reply.
 */
export async function createIssue(input: {
  title: string;
  body: string;
  labels: readonly string[];
}): Promise<CreatedIssue> {
  const { repo, token } = config.github;
  if (!token) throw new Error('GitHub issue token is not configured');
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'nz-claude-community-agent',
    },
    body: JSON.stringify({ title: input.title, body: input.body, labels: [...input.labels] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { number: number; html_url: string };
  return { number: json.number, url: json.html_url };
}
