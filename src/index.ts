#!/usr/bin/env node
/**
 * @chronary/agent-init — one-liner agent bootstrap.
 *
 *   npx @chronary/agent-init [--email <e>] [--otp <n>] [--api <url>]
 *   npx @chronary/agent-init --anonymous
 *
 * Performs (email flow):
 *   1. POST /v1/agent/sign-up
 *   2. Reads OTP from CHRONARY_OTP / --otp / stdin (TTY only)
 *   3. POST /v1/agent/verify
 *   4. POST /v1/calendars (smoke calendar to prove write access)
 *
 * With --anonymous (#2335), no email and no OTP:
 *   1. POST /v1/agent/sign-up/anonymous: a claimable org whose key works at
 *      once, plus a one-time claim link for the person who should own it
 *   2. POST /v1/calendars
 *   Unclaimed, the org's key stops and its data is deleted after 72 hours.
 *
 * Inputs (env vars take precedence over flags so CI / Claude Code / Cursor
 * can wire the bootstrap without TTY tricks):
 *   CHRONARY_EMAIL      — required for the email flow if --email not given
 *   CHRONARY_OTP        — optional; if missing and stdin is TTY, prompt; else exit 2
 *   CHRONARY_API        — defaults to https://api.chronary.ai
 *   CHRONARY_ANONYMOUS  — `1` or `true` selects the no-email flow
 *
 * Exits:
 *   0 — success; api_key printed to stdout (machine-readable on last line,
 *       or one JSON line with --json)
 *   1 — API error (sign-up / verify / calendar creation)
 *   2 — missing or conflicting input
 *   3 — non-zero after exhausting retries (429)
 */

import { stdin, stdout, stderr, env, argv, exit } from 'node:process';
import * as readline from 'node:readline/promises';
import { VERSION } from './version.js';
import { MAX_RETRY_AFTER_SECONDS, retryWaitSeconds } from './retry.js';

interface Args {
  email?: string;
  otp?: string;
  api: string;
  agentName: string;
  tosVersion?: string;
  anonymous: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    api: env.CHRONARY_API ?? 'https://api.chronary.ai',
    agentName: env.CHRONARY_AGENT_NAME ?? 'Bootstrap Agent',
    email: env.CHRONARY_EMAIL,
    otp: env.CHRONARY_OTP,
    tosVersion: env.CHRONARY_TOS_VERSION,
    anonymous: env.CHRONARY_ANONYMOUS === '1' || env.CHRONARY_ANONYMOUS?.toLowerCase() === 'true',
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--otp') out.otp = argv[++i];
    else if (a === '--api') out.api = argv[++i];
    else if (a === '--agent-name') out.agentName = argv[++i];
    else if (a === '--tos-version') out.tosVersion = argv[++i];
    else if (a === '--anonymous') out.anonymous = true;
    else if (a === '--json') out.json = true;
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
  --anonymous            Sign up without an email (CHRONARY_ANONYMOUS=1): the key
                         works at once at Sandbox limits; give the printed claim
                         link to the person who should own the calendar. Unclaimed,
                         everything is deleted after 72 hours. No --email or --otp.
  --json                 Print one JSON line on stdout instead of the bare key
  --api <url>            API base URL (CHRONARY_API, default api.chronary.ai)
  --agent-name <name>    Display name for the default agent
  --tos-version <ver>    Override ToS version (else fetched at runtime)
  -h, --help             Show this help

Signing up accepts the Terms of Service (https://chronary.ai/terms) for the
person or organization you act for.

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
    if (r.status === 202 && (r.body as { waitlisted?: unknown } | null)?.waitlisted === true) {
      // Sign-ups are paused (waitlist mode or early access full). The API
      // gives every address the same body and no key (#1655).
      const message = (r.body as { message?: string }).message ?? 'Sign-ups are paused.';
      throw new Error(`No API key issued: ${message}`);
    }
    // A rate-limit 429 waits (Retry-After, at most 60s); a quota 429 is not retried (#1936).
    const wait = retryWaitSeconds(r, attempt);
    if (wait !== null) {
      stderr.write(`Rate-limited (429); sleeping ${wait}s before retry…\n`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    throw new Error(`Sign-up failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  exit(3);
}

interface AnonymousSignUp {
  apiKey: string;
  orgId: string;
  agentId: string;
  claimUrl: string;
  expiresAt: string;
}

function errorOf(body: unknown): { type?: string; message?: string; currentVersion?: string } {
  const e = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!e || typeof e !== 'object') return {};
  const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  return { type: s(e.type), message: s(e.message), currentVersion: s(e.current_version) };
}

/**
 * POST /v1/agent/sign-up/anonymous (#2335). When the Terms version was read
 * from the API (`retryStale`), a 409 `tos_version_stale` means the Terms moved
 * between the two calls: retry once with `current_version`. A version the
 * caller pinned (--tos-version / CHRONARY_TOS_VERSION) is never swapped for
 * another: the 409 is reported with the current version. A burst 429 is
 * retried like the email flow; a network-budget 429 with a long Retry-After
 * is reported, not slept on.
 */
async function signUpAnonymousWithBackoff(
  api: string,
  payload: { agent_name: string; tos_version: string },
  retryStale: boolean,
): Promise<AnonymousSignUp> {
  let tosVersion = payload.tos_version;
  let staleRetried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchJson(`${api}/v1/agent/sign-up/anonymous`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, tos_version: tosVersion }),
    });
    const err = errorOf(r.body);
    if (r.status === 201) {
      const body = r.body as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
      const out = {
        apiKey: s(body.api_key),
        orgId: s(body.org_id),
        agentId: s(body.agent_id),
        claimUrl: s(body.claim_url),
        expiresAt: s(body.expires_at),
      };
      if (!out.apiKey || !out.orgId || !out.agentId || !out.claimUrl || !out.expiresAt) {
        throw new Error('Sign-up answered 201 without the key, claim link and expiry.');
      }
      return out as AnonymousSignUp;
    }
    if (r.status === 409 && err.type === 'tos_version_stale' && !retryStale) {
      throw new Error(
        `The Terms version you pinned (${tosVersion}) is out of date; the current version is ` +
          `${err.currentVersion ?? 'unknown'}. Read https://chronary.ai/terms and pass --tos-version ` +
          `${err.currentVersion ?? '<current>'} to accept it, or drop --tos-version.`,
      );
    }
    if (r.status === 409 && err.type === 'tos_version_stale' && err.currentVersion && !staleRetried && err.currentVersion !== tosVersion) {
      stderr.write(`  ToS moved to ${err.currentVersion}; retrying with it.\n`);
      tosVersion = err.currentVersion;
      staleRetried = true;
      attempt--;
      continue;
    }
    if (r.status === 503 && err.type === 'anonymous_signup_disabled') {
      throw new Error('Sign-up without an email is not available on this API. Run again with --email <address>.');
    }
    if (r.status === 503) {
      throw new Error(`No API key issued: ${err.message ?? 'sign-ups are unavailable right now.'}`);
    }
    if (r.status === 429 && r.retryAfter !== undefined && r.retryAfter > MAX_RETRY_AFTER_SECONDS) {
      const minutes = Math.ceil(r.retryAfter / 60);
      throw new Error(`${err.message ?? 'Sign-up limit for this network reached.'} Try again in about ${minutes} minute(s), or use --email.`);
    }
    const wait = retryWaitSeconds(r, attempt);
    if (wait !== null) {
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

/** Hours until an ISO time, rounded, for the expiry line. */
function hoursUntil(iso: string): number | null {
  const ms = Date.parse(iso) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 3_600_000)) : null;
}

async function mainAnonymous(args: Args): Promise<void> {
  if (args.email || args.otp) {
    stderr.write(
      'agent-init: --anonymous signs up without an email; drop --email / --otp ' +
        '(and unset CHRONARY_EMAIL / CHRONARY_OTP), or drop --anonymous.\n',
    );
    exit(2);
  }

  stderr.write(`Bootstrapping a claimable agent (no email) at ${args.api}\n`);
  // A pinned version is the caller's choice: never swapped on a 409.
  const tosPinned = args.tosVersion !== undefined;
  const tosVersion = args.tosVersion ?? (await fetchTos(args.api));
  stderr.write(`  ToS version: ${tosVersion}\n`);

  const signup = await signUpAnonymousWithBackoff(
    args.api,
    { agent_name: args.agentName, tos_version: tosVersion },
    !tosPinned,
  );
  stderr.write(`  Org:   ${signup.orgId}\n`);
  stderr.write(`  Agent: ${signup.agentId}\n`);

  // The org exists now, and its key and claim link are shown only in this
  // response: print them before anything else can fail (review of #2435).
  const hours = hoursUntil(signup.expiresAt);
  stderr.write(
    '\nThis calendar has no owner yet.\n\n' +
      'Claim link: give it to the person who should own this calendar. It works once;\n' +
      'opening it while signed in to the Chronary console moves the agent, calendar and\n' +
      'events into their account, and this key then stops working.\n' +
      `  ${signup.claimUrl}\n\n` +
      `Expires: ${signup.expiresAt}${hours === null ? '' : ` (in about ${hours} hours)`}. Unclaimed, the key\n` +
      'stops working then and the calendar and its events are deleted.\n\n' +
      `Export your key:\n  export CHRONARY_API_KEY=${signup.apiKey}\n\n`,
  );

  // The smoke calendar is a convenience: a failure here is a warning, never
  // an exit, so stdout below always carries the key (or the JSON line).
  let calendarId: string | null = null;
  try {
    const cal = await createSmokeCalendar(args.api, signup.apiKey);
    calendarId = typeof cal?.id === 'string' ? cal.id : null;
    stderr.write(`  Created calendar ${calendarId ?? '(no id in the response)'}.\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(
      `agent-init: warning: ${msg}\n` +
        '  The sign-up worked: the key and the claim link above are valid. Create a calendar\n' +
        '  yourself with POST /v1/agents/<agent_id>/calendars.\n',
    );
  }

  if (args.json) {
    stdout.write(
      `${JSON.stringify({
        api_key: signup.apiKey,
        org_id: signup.orgId,
        agent_id: signup.agentId,
        calendar_id: calendarId,
        claim_url: signup.claimUrl,
        expires_at: signup.expiresAt,
      })}\n`,
    );
  } else {
    // Last line of stdout is machine-readable — pipe-into-eval friendly.
    stdout.write(`${signup.apiKey}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.anonymous) {
    await mainAnonymous(args);
    return;
  }
  if (!args.email) {
    stderr.write('agent-init: --email or CHRONARY_EMAIL is required\n');
    exit(2);
  }

  // Validate a pre-supplied OTP (--otp / CHRONARY_OTP) BEFORE any remote call
  // so a malformed value short-circuits before sign-up provisions an org/agent.
  // The interactive path can't be checked here (the OTP doesn't exist until the
  // sign-up email is sent); it's covered by the post-sign-up check below.
  if (args.otp !== undefined && !/^\d{6}$/.test(args.otp)) {
    stderr.write(`agent-init: OTP must be exactly 6 digits, got ${JSON.stringify(args.otp)}\n`);
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

  if (args.json) {
    stdout.write(
      `${JSON.stringify({ api_key: signup.apiKey, org_id: signup.orgId, agent_id: signup.agentId, calendar_id: cal.id })}\n`,
    );
  } else {
    // Last line of stdout is machine-readable — pipe-into-eval friendly.
    stdout.write(`${signup.apiKey}\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  stderr.write(`agent-init: ${msg}\n`);
  exit(1);
});
