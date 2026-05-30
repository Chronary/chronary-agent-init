#!/usr/bin/env node
/**
 * @chronary/agent-init — one-liner agent bootstrap.
 *
 *   npx @chronary/agent-init [--email <e>] [--otp <n>] [--api <url>]
 *
 * Performs:
 *   1. POST /v1/agent/sign-up
 *   2. Reads OTP from CHRONARY_OTP / --otp / stdin (TTY only)
 *   3. POST /v1/agent/verify
 *   4. POST /v1/calendars (smoke calendar to prove write access)
 *
 * Inputs (env vars take precedence over flags so CI / Claude Code / Cursor
 * can wire the bootstrap without TTY tricks):
 *   CHRONARY_EMAIL  — required if --email not given
 *   CHRONARY_OTP    — optional; if missing and stdin is TTY, prompt; else exit 2
 *   CHRONARY_API    — defaults to https://api.chronary.ai
 *
 * Exits:
 *   0 — success; api_key printed to stdout (machine-readable on last line)
 *   1 — API error (sign-up / verify / calendar creation)
 *   2 — missing required input
 *   3 — non-zero after exhausting retries (429)
 */

import { stdin, stdout, stderr, env, argv, exit } from 'node:process';
import * as readline from 'node:readline/promises';
import { VERSION } from './version.js';

interface Args {
  email?: string;
  otp?: string;
  api: string;
  agentName: string;
  tosVersion?: string;
}

function parseArgs(): Args {
  const out: Args = {
    api: env.CHRONARY_API ?? 'https://api.chronary.ai',
    agentName: env.CHRONARY_AGENT_NAME ?? 'Bootstrap Agent',
    email: env.CHRONARY_EMAIL,
    otp: env.CHRONARY_OTP,
    tosVersion: env.CHRONARY_TOS_VERSION,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--otp') out.otp = argv[++i];
    else if (a === '--api') out.api = argv[++i];
    else if (a === '--agent-name') out.agentName = argv[++i];
    else if (a === '--tos-version') out.tosVersion = argv[++i];
    else if (a === '--help' || a === '-h') {
      stdout.write(HELP);
      exit(0);
    } else if (a === '--version' || a === '-v') {
      stdout.write(`${VERSION}\n`);
      exit(0);
    } else {
      stderr.write(`agent-init: unknown flag ${a}\n${HELP}`);
      exit(2);
    }
  }
  return out;
}

const HELP = `Usage: chronary-agent-init [flags]

Flags (env vars take precedence):
  --email <addr>         Email for sign-up (CHRONARY_EMAIL)
  --otp <6 digits>       OTP, if you already have it (CHRONARY_OTP)
  --api <url>            API base URL (CHRONARY_API, default api.chronary.ai)
  --agent-name <name>    Display name for the default agent
  --tos-version <ver>    Override ToS version (else fetched at runtime)
  -h, --help             Show this help

Exit codes: 0 ok · 1 API error · 2 bad input · 3 retries exhausted
`;

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; retryAfter?: number }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body, retryAfter };
}

async function fetchTos(api: string): Promise<string> {
  const { status, body } = await fetchJson(`${api}/v1/auth/terms/current`);
  if (status !== 200 || typeof (body as { version?: unknown })?.version !== 'string') {
    throw new Error(`Could not fetch current ToS version (status=${status}). Pass --tos-version.`);
  }
  return (body as { version: string }).version;
}

async function signUpWithBackoff(
  api: string,
  payload: { email: string; agent_name: string; tos_version: string },
): Promise<{ apiKey: string; orgId: string; agentId: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchJson(`${api}/v1/agent/sign-up`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (r.status === 200) {
      const body = r.body as {
        api_key?: string;
        org_id?: string;
        agent_id?: string;
        message?: string;
      };
      if (body.api_key && body.org_id && body.agent_id) {
        return { apiKey: body.api_key, orgId: body.org_id, agentId: body.agent_id };
      }
      throw new Error(
        'Sign-up succeeded but returned the opaque (duplicate) response. ' +
          'The email may already be registered. ' +
          'If you have the prior API key, set CHRONARY_API_KEY and skip this command.',
      );
    }
    if (r.status === 429) {
      const wait = r.retryAfter ?? Math.pow(2, attempt) * 5;
      stderr.write(`Rate-limited (429); sleeping ${wait}s before retry…\n`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    throw new Error(`Sign-up failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  exit(3);
}

async function readOtpInteractive(): Promise<string> {
  if (!stdin.isTTY) {
    stderr.write(
      'agent-init: stdin is not a TTY and CHRONARY_OTP is unset. ' +
        'Set CHRONARY_OTP=<6 digits> or pass --otp.\n',
    );
    exit(2);
  }
  const rl = readline.createInterface({ input: stdin, output: stderr });
  try {
    const answer = await rl.question('Enter the 6-digit OTP from your email: ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function verifyOtp(api: string, apiKey: string, otp: string): Promise<void> {
  const r = await fetchJson(`${api}/v1/agent/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ otp }),
  });
  if (r.status !== 200) {
    throw new Error(`Verify failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
}

async function createSmokeCalendar(
  api: string,
  apiKey: string,
): Promise<{ id: string }> {
  const r = await fetchJson(`${api}/v1/calendars`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      name: 'Welcome to Chronary',
      timezone: env.TZ ?? 'UTC',
    }),
  });
  if (r.status !== 201) {
    throw new Error(`Create calendar failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body as { id: string };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.email) {
    stderr.write('agent-init: --email or CHRONARY_EMAIL is required\n');
    exit(2);
  }

  stderr.write(`Bootstrapping agent at ${args.api}\n`);

  const tosVersion = args.tosVersion ?? (await fetchTos(args.api));
  stderr.write(`  ToS version: ${tosVersion}\n`);

  const signup = await signUpWithBackoff(args.api, {
    email: args.email,
    agent_name: args.agentName,
    tos_version: tosVersion,
  });
  stderr.write(`  Org:   ${signup.orgId}\n`);
  stderr.write(`  Agent: ${signup.agentId}\n`);

  const otp = args.otp ?? (await readOtpInteractive());
  if (!/^\d{6}$/.test(otp)) {
    stderr.write(`agent-init: OTP must be exactly 6 digits, got ${JSON.stringify(otp)}\n`);
    exit(2);
  }
  await verifyOtp(args.api, signup.apiKey, otp);
  stderr.write(`  Verified.\n`);

  const cal = await createSmokeCalendar(args.api, signup.apiKey);
  stderr.write(`  Created calendar ${cal.id}.\n`);
  stderr.write(`\nDone. Export your key:\n  export CHRONARY_API_KEY=${signup.apiKey}\n`);

  // Last line of stdout is machine-readable — pipe-into-eval friendly.
  stdout.write(`${signup.apiKey}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  stderr.write(`agent-init: ${msg}\n`);
  exit(1);
});
