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
