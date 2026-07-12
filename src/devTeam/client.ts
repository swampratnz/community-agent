// Typed HTTP client for the remote "dev-team" dispatch service (the super-admin
// dev_team_* tools in src/agent/tools.ts, and the completion-DM poller in
// src/backgroundJobs.ts). Codes to a FROZEN contract:
//
//   POST /jobs        {mode,repo,title,description,budget_usd} -> 202 {id,state,position}
//   GET  /jobs                                                 -> {jobs:[...]}
//   GET  /jobs/{id}                                            -> {id,mode,repo,state,...}
//   GET  /jobs/{id}/result                                     -> {kind,...} | 409 {error,state}
//
// The service is a tailnet-internal endpoint (config.devTeam.endpointUrl, which
// deliberately allows http:// — see config.ts). Every request carries
// `Authorization: Bearer <token>`. Design mirrors src/status/anthropicStatus.ts
// and src/github/issues.ts: a per-request timeout, throw-on-non-2xx with the
// status + a CAPPED body, and an injectable `fetchImpl` so tests never touch the
// network. The token lives only in the request header — it is never logged, and
// never appears in a thrown error message (which carries status + body only).

export type JobMode = 'assess' | 'deliver';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

/** Response to POST /jobs (HTTP 202). */
export interface DispatchResponse {
  id: string;
  state: 'queued';
  position: number;
}

export interface JobProgressEntry {
  role: string;
  stage: string;
  message: string;
  ts: string;
}

/** GET /jobs/{id}. */
export interface JobStatus {
  id: string;
  mode: JobMode;
  repo: string;
  state: JobState;
  started: string | null;
  ended: string | null;
  cost_usd: number | null;
  error: string | null;
  progress: JobProgressEntry[];
}

/** One entry of GET /jobs. */
export interface JobListEntry {
  id: string;
  mode: JobMode;
  repo: string;
  state: JobState;
  started: string | null;
  ended: string | null;
}

export interface JobListResponse {
  jobs: JobListEntry[];
}

/**
 * GET /jobs/{id}/result. Loosely typed: the succeeded-assess shape and the
 * succeeded-deliver shape share `kind`/`success`/`cost_usd`, and a failed job
 * carries `error`. Callers read the fields they know about and treat the rest
 * as optional, so a forward-compatible service field never breaks the client.
 */
export interface JobResult {
  kind: string;
  success: boolean;
  classification?: string;
  executive_summary?: string;
  report_path?: string;
  report_markdown?: string;
  error?: string;
  cost_usd: number | null;
  [key: string]: unknown;
}

export interface DispatchInput {
  mode: JobMode;
  repo: string;
  title?: string;
  description?: string;
  budget_usd?: number | null;
}

export type FetchImpl = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

/** Trim a single trailing slash so `${base}/jobs` never doubles up. */
function baseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Perform one authenticated request and parse the JSON body. Throws on a
 * non-2xx response with the status text plus a CAPPED slice of the body (200
 * chars) so a large/hostile service response can never blow up a chat reply.
 * The bearer token is only ever sent as a header; it is never included in the
 * thrown message.
 */
async function request<T>(
  endpoint: string,
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
): Promise<T> {
  const res = await fetchImpl(`${baseUrl(endpoint)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Dev-team service ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** POST /jobs — dispatch an assess/deliver job. */
export async function dispatchJob(
  endpoint: string,
  token: string,
  input: DispatchInput,
  fetchImpl: FetchImpl = fetch,
): Promise<DispatchResponse> {
  return request<DispatchResponse>(
    endpoint,
    token,
    '/jobs',
    {
      method: 'POST',
      body: JSON.stringify({
        mode: input.mode,
        repo: input.repo,
        title: input.title,
        description: input.description,
        budget_usd: input.budget_usd ?? null,
      }),
    },
    fetchImpl,
  );
}

/** GET /jobs/{id} — one job's current status. */
export async function jobStatus(
  endpoint: string,
  token: string,
  id: string,
  fetchImpl: FetchImpl = fetch,
): Promise<JobStatus> {
  return request<JobStatus>(endpoint, token, `/jobs/${encodeURIComponent(id)}`, { method: 'GET' }, fetchImpl);
}

/** GET /jobs/{id}/result — the finished result (throws on 409 "not finished"). */
export async function jobResult(
  endpoint: string,
  token: string,
  id: string,
  fetchImpl: FetchImpl = fetch,
): Promise<JobResult> {
  return request<JobResult>(
    endpoint,
    token,
    `/jobs/${encodeURIComponent(id)}/result`,
    { method: 'GET' },
    fetchImpl,
  );
}

/** GET /jobs — recent jobs. */
export async function listJobs(
  endpoint: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<JobListResponse> {
  return request<JobListResponse>(endpoint, token, '/jobs', { method: 'GET' }, fetchImpl);
}

/**
 * Neutralize a short service-derived identifier field (job id, mode, repo,
 * state, timestamps) before it is spliced into model-visible tool text or an
 * outbound DM: the dispatch contract says these are plain slugs/enums, but
 * nothing client-side enforces that a hostile/compromised service (or an
 * injection-shaped tool argument echoed back) did not put instruction text,
 * newlines, or angle brackets in them. Free-TEXT service fields (errors,
 * progress, report prose) additionally get the full untrusted() quarantine in
 * src/agent/tools.ts — this lighter strip keeps one-line status/list/DM text
 * readable while closing the same injection class.
 */
export function devTeamField(v: string | number | null | undefined): string {
  return String(v ?? '').replace(/[<>\r\n]/g, ' ');
}
