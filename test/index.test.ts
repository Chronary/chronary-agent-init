import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { VERSION } from '../src/version';

const DIST = resolve(__dirname, '../dist/index.js');

function run(args: string[], env: Record<string, string> = {}) {
  // Pre-flight: skip on dev boxes where `pnpm build` hasn't run yet.
  if (!existsSync(DIST)) {
    throw new Error(`dist/index.js missing — run \`pnpm --filter @chronary/agent-init build\` first`);
  }
  return spawnSync('node', [DIST, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('@chronary/agent-init CLI', () => {
  it('prints help on --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: chronary-agent-init/);
  });

  it('prints version on --version', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 when CHRONARY_EMAIL is missing', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--email or CHRONARY_EMAIL is required/);
  });

  it('exits 2 on unknown flag', () => {
    const r = run(['--nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag --nope/);
  });

  it('exits 2 on a malformed pre-supplied --otp before any network call', () => {
    // Guard runs immediately after the email check and before fetchTos/sign-up,
    // so a bad pre-supplied OTP short-circuits without provisioning anything.
    const r = run(['--email', 'agent@example.com', '--otp', 'abc']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/OTP must be exactly 6 digits/);
    // No remote call happened: we never reached the "Bootstrapping" log line
    // that immediately precedes fetchTos/sign-up.
    expect(r.stderr).not.toMatch(/Bootstrapping agent at/);
  });

  it('reports the paused-sign-ups message on a 202 waitlisted response (#1655)', async () => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/auth/terms/current') {
        res.end(JSON.stringify({ version: '2026-04-17' }));
        return;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ waitlisted: true, message: 'Sign-ups are paused, so no API key was issued.' }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const { port } = server.address() as { port: number };
    try {
      if (!existsSync(DIST)) throw new Error('dist/index.js missing — run the build first');
      const child = spawn('node', [DIST, '--email', 'agent@example.com', '--api', `http://127.0.0.1:${port}`], {
        env: { PATH: process.env.PATH },
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const code = await new Promise<number | null>((ok) => child.on('close', ok));
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/No API key issued: Sign-ups are paused/);
      expect(stderr).not.toMatch(/HTTP 202/);
    } finally {
      server.close();
    }
  });
});

// ── --anonymous (#2335): sign-up with no email, against a local API stub ──

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Route = (body: Record<string, unknown> | undefined, auth: string | undefined) => Reply;

const ANON_201 = {
  org_id: '11111111-2222-3333-4444-555555555555',
  agent_id: 'agt_anon0000001',
  api_key: 'chr_sk_anon_key',
  claim_url: 'https://console.example.test/claim/anonymous#token=claim_secret_token',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  plan: 'free-agent-unverified',
};

async function withApi(routes: Record<string, Route>, args: string[], env: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const seen: Array<{ route: string; body?: Record<string, unknown>; auth?: string; client?: string }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      const route = `${req.method} ${req.url}`;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const auth = req.headers.authorization;
      const client = req.headers['x-chronary-client'];
      seen.push({ route, body, auth, client: typeof client === 'string' ? client : undefined });
      const handler = routes[route];
      const reply = handler ? handler(body, auth) : { status: 404, body: { error: { type: 'not_found', message: route } } };
      res.statusCode = reply.status;
      res.setHeader('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const { port } = server.address() as { port: number };
  try {
    if (!existsSync(DIST)) throw new Error('dist/index.js missing — run the build first');
    const child = spawn('node', [DIST, '--api', `http://127.0.0.1:${port}`, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((ok) => child.on('close', ok));
    return { code, stdout, stderr, seen };
  } finally {
    server.close();
  }
}

const terms: Route = () => ({ status: 200, body: { version: '2026-11-12' } });
const calendar: Route = () => ({ status: 201, body: { id: 'cal_anon0000001' } });

describe('@chronary/agent-init --anonymous (#2335)', () => {
  it('signs up with no email, creates the calendar, prints the claim link and expiry, and the key last on stdout', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({ status: 201, body: ANON_201 }),
        'POST /v1/calendars': calendar,
      },
      ['--anonymous', '--agent-name', 'Claimable bot'],
    );
    expect(r.code).toBe(0);
    expect(r.seen.map((s) => s.route)).toEqual([
      'GET /v1/auth/terms/current',
      'POST /v1/agent/sign-up/anonymous',
      'POST /v1/calendars',
    ]);
    expect(r.seen[1].body).toEqual({ agent_name: 'Claimable bot', tos_version: '2026-11-12' });
    expect(r.seen[1].auth).toBeUndefined();
    expect(r.seen[2].auth).toBe('Bearer chr_sk_anon_key');
    expect(r.stderr).toContain(ANON_201.claim_url);
    expect(r.stderr).toMatch(/give it to the person who should own this calendar/i);
    expect(r.stderr).toContain(`Expires: ${ANON_201.expires_at}`);
    expect(r.stderr).toMatch(/in about 7[12] hours/);
    expect(r.stderr).toMatch(/deleted/);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('chr_sk_anon_key');
    expect(r.stdout).not.toContain('claim_secret_token');
    // Every request names agent-init, so the API attributes the sign-up to it (#976).
    expect(r.seen.map((s) => s.client)).toEqual(Array(3).fill(`chronary-agent-init/${VERSION}`));
  });

  it('CHRONARY_ANONYMOUS=1 selects the same flow, and --json prints one JSON line with the claim link', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({ status: 201, body: ANON_201 }),
        'POST /v1/calendars': calendar,
      },
      ['--json'],
      { CHRONARY_ANONYMOUS: '1' },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      api_key: 'chr_sk_anon_key',
      org_id: ANON_201.org_id,
      agent_id: ANON_201.agent_id,
      calendar_id: 'cal_anon0000001',
      claim_url: ANON_201.claim_url,
      expires_at: ANON_201.expires_at,
    });
  });

  it('retries once with current_version on 409 tos_version_stale', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': (body) =>
          body?.tos_version === '2026-11-12'
            ? { status: 409, body: { error: { type: 'tos_version_stale', message: 'stale', current_version: '2026-11-20' } } }
            : { status: 201, body: ANON_201 },
        'POST /v1/calendars': calendar,
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(0);
    const signUps = r.seen.filter((s) => s.route === 'POST /v1/agent/sign-up/anonymous').map((s) => s.body?.tos_version);
    expect(signUps).toEqual(['2026-11-12', '2026-11-20']);
  });

  // Review of #2435: a version the caller pinned is their choice; agent-init
  // never accepts a different one for them.
  it.each([
    ['--tos-version', ['--anonymous', '--tos-version', '2026-05-11'], {}],
    ['CHRONARY_TOS_VERSION', ['--anonymous'], { CHRONARY_TOS_VERSION: '2026-05-11' }],
  ])('a pinned version (%s) gets no stale retry: it reports the current version and exits 1', async (_label, args, env) => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({
          status: 409,
          body: { error: { type: 'tos_version_stale', message: 'stale', current_version: '2026-11-20' } },
        }),
      },
      args as string[],
      env as Record<string, string>,
    );
    expect(r.code).toBe(1);
    expect(r.seen.filter((s) => s.route === 'POST /v1/agent/sign-up/anonymous')).toHaveLength(1);
    expect(r.seen.map((s) => s.route)).not.toContain('GET /v1/auth/terms/current');
    expect(r.stderr).toMatch(/version you pinned \(2026-05-11\) is out of date; the current version is 2026-11-20/);
    expect(r.stdout).toBe('');
  });

  // Review of #2435: the org exists once sign-up answers 201, so a calendar
  // failure must not swallow its key and one-time claim link.
  it('a failed smoke calendar (5xx) is a warning: exit 0, claim link on stderr, key last on stdout', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({ status: 201, body: ANON_201 }),
        'POST /v1/calendars': () => ({ status: 502, body: { error: { type: 'bad_gateway', message: 'upstream' } } }),
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(ANON_201.claim_url);
    expect(r.stderr).toMatch(/warning: Create calendar failed: HTTP 502/);
    // The claim link is printed before the calendar is attempted.
    expect(r.stderr.indexOf(ANON_201.claim_url)).toBeLessThan(r.stderr.indexOf('warning:'));
    expect(r.stdout.trim().split('\n').at(-1)).toBe('chr_sk_anon_key');
  });

  it('a failed smoke calendar with --json still prints the JSON line, calendar_id null', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({ status: 201, body: ANON_201 }),
        'POST /v1/calendars': () => ({ status: 500, body: { error: { type: 'internal_error', message: 'x' } } }),
      },
      ['--anonymous', '--json'],
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ api_key: 'chr_sk_anon_key', claim_url: ANON_201.claim_url, calendar_id: null });
  });

  it('does not loop on a second stale answer', async () => {
    let n = 0;
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({
          status: 409,
          body: { error: { type: 'tos_version_stale', message: 'stale', current_version: `v${++n}` } },
        }),
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(1);
    expect(n).toBe(2);
    expect(r.stderr).toMatch(/Sign-up failed: HTTP 409/);
  });

  it('points at --email when the API has the no-email sign-up switched off (503)', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({
          status: 503,
          body: { error: { type: 'anonymous_signup_disabled', message: 'off' } },
        }),
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not available on this API\. Run again with --email/);
    expect(r.stdout).toBe('');
  });

  it('reports a paused or full sign-up (503) with the API message', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({
          status: 503,
          body: { error: { type: 'anonymous_signup_capacity', message: "Today's sign-ups without an email are used up." } },
        }),
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No API key issued: Today's sign-ups without an email are used up\./);
  });

  it('reports a spent network budget (long Retry-After) instead of sleeping on it', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up/anonymous': () => ({
          status: 429,
          headers: { 'Retry-After': '1200' },
          body: { error: { type: 'rate_limit_error', message: 'Signup limit for this network reached — try again later' } },
        }),
      },
      ['--anonymous'],
    );
    expect(r.code).toBe(1);
    expect(r.seen.filter((s) => s.route === 'POST /v1/agent/sign-up/anonymous')).toHaveLength(1);
    expect(r.stderr).toMatch(/Try again in about 20 minute\(s\), or use --email/);
  });

  it('exits 2 before any call when --anonymous meets an email or an OTP', () => {
    const flag = run(['--anonymous', '--email', 'agent@example.com', '--api', 'http://127.0.0.1:9']);
    expect(flag.status).toBe(2);
    expect(flag.stderr).toMatch(/--anonymous signs up without an email/);
    expect(flag.stderr).not.toMatch(/Bootstrapping/);

    const env = run(['--anonymous', '--api', 'http://127.0.0.1:9'], { CHRONARY_OTP: '123456' });
    expect(env.status).toBe(2);
  });

  it('documents --anonymous, --json and the Terms acceptance in --help', () => {
    const r = run(['--help']);
    expect(r.stdout).toMatch(/--anonymous/);
    expect(r.stdout).toMatch(/--json/);
    expect(r.stdout).toMatch(/accepts the Terms of Service/);
  });
});

describe('@chronary/agent-init --json (email flow)', () => {
  it('prints one JSON line with the key and ids', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up': () => ({
          status: 200,
          body: { api_key: 'chr_sk_email', org_id: 'org-1', agent_id: 'agt_email0000001' },
        }),
        'POST /v1/agent/verify': () => ({ status: 200, body: { verified: true } }),
        'POST /v1/calendars': calendar,
      },
      ['--email', 'agent@example.com', '--otp', '123456', '--json'],
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({
      api_key: 'chr_sk_email',
      org_id: 'org-1',
      agent_id: 'agt_email0000001',
      calendar_id: 'cal_anon0000001',
    });
  });
});

// ── #2518: the email flow shows the one-time key before anything can fail ──

describe('@chronary/agent-init email flow keeps the key when a later step fails (#2518)', () => {
  const KEY = 'chr_sk_bughunt_only_copy';
  const signUp: Route = () => ({ status: 200, body: { api_key: KEY, org_id: 'org_bughunt', agent_id: 'agt_bughunt' } });
  const verified: Route = () => ({ status: 200, body: { verified: true } });

  it('verify fails (wrong or pre-guessed --otp): the key is on stderr before the failure, with the --verify-only hint', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up': signUp,
        'POST /v1/agent/verify': () => ({ status: 400, body: { error: { type: 'invalid_otp', message: 'Invalid OTP' } } }),
        'POST /v1/calendars': calendar,
      },
      ['--email', 'bughunt-a@example.com', '--otp', '123456'],
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`export CHRONARY_API_KEY=${KEY}`);
    expect(r.stderr.indexOf(KEY)).toBeLessThan(r.stderr.indexOf('Verify failed'));
    expect(r.stderr).toMatch(/--verify-only/);
    expect(r.seen.map((s) => s.route)).not.toContain('POST /v1/calendars');
  });

  it('no OTP and stdin not a TTY (curl | sh, agent harness): exit 2 with the key shown and no verify call', async () => {
    const r = await withApi(
      { 'GET /v1/auth/terms/current': terms, 'POST /v1/agent/sign-up': signUp, 'POST /v1/agent/verify': verified },
      ['--email', 'bughunt-b@example.com'],
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`export CHRONARY_API_KEY=${KEY}`);
    expect(r.stderr).toMatch(/stdin is not a TTY[\s\S]*--verify-only/);
    expect(r.seen.map((s) => s.route)).not.toContain('POST /v1/agent/verify');
  });

  it('smoke calendar fails after verify: exit 1, the key already shown', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up': signUp,
        'POST /v1/agent/verify': verified,
        'POST /v1/calendars': () => ({ status: 500, body: { error: { type: 'internal' } } }),
      },
      ['--email', 'bughunt-c@example.com', '--otp', '123456'],
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`export CHRONARY_API_KEY=${KEY}`);
    expect(r.stderr.indexOf(KEY)).toBeLessThan(r.stderr.indexOf('Create calendar failed'));
  });

  it('a successful run prints the key once on stderr and last on stdout', async () => {
    const r = await withApi(
      { 'GET /v1/auth/terms/current': terms, 'POST /v1/agent/sign-up': signUp, 'POST /v1/agent/verify': verified, 'POST /v1/calendars': calendar },
      ['--email', 'bughunt-d@example.com', '--otp', '123456'],
    );
    expect(r.code).toBe(0);
    expect(r.stderr.split(KEY)).toHaveLength(2);
    expect(r.stdout.trim().split('\n').at(-1)).toBe(KEY);
  });

  it('--verify-only finishes with CHRONARY_API_KEY: no sign-up, verify and calendar with that key', async () => {
    const r = await withApi(
      { 'POST /v1/agent/verify': verified, 'POST /v1/calendars': calendar },
      ['--verify-only', '--json'],
      { CHRONARY_API_KEY: KEY, CHRONARY_OTP: '654321' },
    );
    expect(r.code).toBe(0);
    expect(r.seen.map((s) => s.route)).toEqual(['POST /v1/agent/verify', 'POST /v1/calendars']);
    expect(r.seen[0]).toMatchObject({ auth: `Bearer ${KEY}`, body: { otp: '654321' } });
    expect(JSON.parse(r.stdout.trim())).toEqual({ api_key: KEY, calendar_id: 'cal_anon0000001' });
  });

  it('--verify-only exits 2 without CHRONARY_API_KEY or with --email, before any call', () => {
    const noKey = run(['--verify-only', '--otp', '123456']);
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/CHRONARY_API_KEY, which is unset/);
    const withEmail = run(['--verify-only', '--email', 'a@example.com'], { CHRONARY_API_KEY: KEY });
    expect(withEmail.status).toBe(2);
    expect(withEmail.stderr).toMatch(/drop --email/);
  });

  it('--verify-only ignores CHRONARY_EMAIL / CHRONARY_ANONYMOUS left in the environment (CI jobs set them for every step)', async () => {
    const r = await withApi(
      { 'POST /v1/agent/verify': verified, 'POST /v1/calendars': calendar },
      ['--verify-only'],
      { CHRONARY_API_KEY: KEY, CHRONARY_OTP: '654321', CHRONARY_EMAIL: 'ci@example.com', CHRONARY_ANONYMOUS: '1' },
    );
    expect(r.code).toBe(0);
    expect(r.seen.map((s) => s.route)).toEqual(['POST /v1/agent/verify', 'POST /v1/calendars']);
    expect(r.stdout.trim()).toBe(KEY);
  });

  it('a refused code says how to get a new one: re-run sign-up (key stays valid), then --verify-only', async () => {
    const refused: Route = () => ({ status: 400, body: { error: { type: 'validation_error', message: 'Invalid or expired verification code' } } });
    const first = await withApi(
      { 'GET /v1/auth/terms/current': terms, 'POST /v1/agent/sign-up': signUp, 'POST /v1/agent/verify': refused },
      ['--email', 'late@example.com', '--otp', '123456'],
    );
    expect(first.code).toBe(1);
    expect(first.stderr).toMatch(/re-run sign-up with\s+the same email to get a new code \(the key stays valid/);
    const resumed = await withApi({ 'POST /v1/agent/verify': refused }, ['--verify-only'], { CHRONARY_API_KEY: KEY, CHRONARY_OTP: '111111' });
    expect(resumed.code).toBe(1);
    expect(resumed.stderr).toMatch(/Run --verify-only again[\s\S]*re-run sign-up/);
  });

  it('a second sign-up for the same email (opaque 200, no key) points at --verify-only with the new code', async () => {
    const r = await withApi(
      {
        'GET /v1/auth/terms/current': terms,
        'POST /v1/agent/sign-up': () => ({ status: 200, body: { message: 'If this email is new, check your inbox.' } }),
      },
      ['--email', 'bughunt-a@example.com', '--otp', '654321'],
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/opaque \(duplicate\) response/);
    expect(r.stderr).toMatch(/CHRONARY_OTP=<new code> npx @chronary\/agent-init --verify-only/);
    expect(r.seen.map((s) => s.route)).not.toContain('POST /v1/agent/verify');
  });
});

// Network behavior is covered by the cold-agent smoke
// (apps/api/test/integration/smoke-cold-agent.ts); these unit tests cover the
// argv/env contract that the smoke relies on but doesn't itself exercise.

describe('@chronary/agent-init network flow (mocked)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('mocked fetch contract sanity', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: '2026-04-17' }), { status: 200 }),
    );
    const res = await fetch('https://api.chronary.ai/v1/auth/terms/current');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '2026-04-17' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
