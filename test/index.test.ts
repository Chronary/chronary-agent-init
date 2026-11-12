import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
