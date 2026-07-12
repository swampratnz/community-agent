import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchJob, jobResult, jobStatus, listJobs, type FetchImpl } from '../src/devTeam/client.js';

// The dev-team client is dependency-free (no config, no DB, no real network):
// `fetchImpl` is always injected here, mirroring src/status/anthropicStatus.ts.

const ENDPOINT = 'http://ubuntudevagent:8738';
const TOKEN = 'dev-team-super-secret-bearer-token';

interface Recorded {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

/** Build an injectable fetch that records the request and returns a canned response. */
function fakeFetch(status: number, responseBody: unknown, sink?: Recorded[]): FetchImpl {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    sink?.push({
      url: String(url),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 400 ? 'Bad Request' : status === 202 ? 'Accepted' : 'OK',
      async text() {
        return text;
      },
      async json() {
        return JSON.parse(text);
      },
    } as Response;
  }) as unknown as FetchImpl;
}

test('SECURITY: dispatchJob sends Authorization: Bearer <token> and a JSON content-type, POSTing to /jobs', async () => {
  const calls: Recorded[] = [];
  const fetchImpl = fakeFetch(202, { id: 'job-1', state: 'queued', position: 3 }, calls);
  const res = await dispatchJob(
    ENDPOINT,
    TOKEN,
    { mode: 'assess', repo: 'owner/name', title: 't', description: 'd', budget_usd: null },
    fetchImpl,
  );
  assert.deepEqual(res, { id: 'job-1', state: 'queued', position: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://ubuntudevagent:8738/jobs');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['authorization'], `Bearer ${TOKEN}`, 'bearer header must carry the token');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body!), {
    mode: 'assess',
    repo: 'owner/name',
    title: 't',
    description: 'd',
    budget_usd: null,
  });
});

test('jobStatus / listJobs / jobResult GET the right paths with the bearer header and parse the body', async () => {
  const statusCalls: Recorded[] = [];
  const status = await jobStatus(
    ENDPOINT,
    TOKEN,
    'job-42',
    fakeFetch(
      200,
      {
        id: 'job-42',
        mode: 'assess',
        repo: 'o/r',
        state: 'running',
        started: '2026-07-12T00:00:00Z',
        ended: null,
        cost_usd: null,
        error: null,
        progress: [],
      },
      statusCalls,
    ),
  );
  assert.equal(status.state, 'running');
  assert.equal(statusCalls[0].url, 'http://ubuntudevagent:8738/jobs/job-42');
  assert.equal(statusCalls[0].method, 'GET');
  assert.equal(statusCalls[0].headers['authorization'], `Bearer ${TOKEN}`);

  const listCalls: Recorded[] = [];
  const list = await listJobs(ENDPOINT, TOKEN, fakeFetch(200, { jobs: [{ id: 'a' }] }, listCalls));
  assert.equal(list.jobs.length, 1);
  assert.equal(listCalls[0].url, 'http://ubuntudevagent:8738/jobs');

  const resultCalls: Recorded[] = [];
  const result = await jobResult(
    ENDPOINT,
    TOKEN,
    'job-9',
    fakeFetch(200, { kind: 'assess', success: true, classification: 'green', cost_usd: 1.5 }, resultCalls),
  );
  assert.equal(result.classification, 'green');
  assert.equal(resultCalls[0].url, 'http://ubuntudevagent:8738/jobs/job-9/result');
});

test('SECURITY: a non-2xx response throws with the status and a CAPPED (200-char) body slice, never the whole body', async () => {
  const longBody = 'x'.repeat(500);
  await assert.rejects(
    () => jobStatus(ENDPOINT, TOKEN, 'job-1', fakeFetch(400, longBody)),
    (err: Error) => {
      assert.match(err.message, /Dev-team service 400 Bad Request:/);
      assert.ok(err.message.includes('x'.repeat(200)), 'the first 200 chars of the body are echoed');
      assert.ok(!err.message.includes('x'.repeat(201)), 'the body must be capped at 200 chars');
      return true;
    },
  );
});

test('SECURITY: the bearer token never appears in a thrown error message (the client only sends it as a header)', async () => {
  await assert.rejects(
    () => jobResult(ENDPOINT, TOKEN, 'job-1', fakeFetch(401, { error: 'unauthorized' })),
    (err: Error) => {
      assert.ok(
        !err.message.includes(TOKEN),
        'the token the client was given must never leak into the error',
      );
      return true;
    },
  );
});
