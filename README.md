# `@chronary/agent-init`

One-liner bootstrap for AI agents on Chronary.

```bash
npx @chronary/agent-init@latest
```

In ~5 seconds the script does this:

1. `POST /v1/agent/sign-up` — provisions a new org + restricted API key
2. Reads the OTP from `CHRONARY_OTP` env, `--otp` flag, or stdin (TTY only)
3. `POST /v1/agent/verify` — moves the org to the Free plan (1 agent, 1 calendar)
4. `POST /v1/calendars` — creates a smoke calendar to prove write access works

The last line of stdout is the new API key, so it composes:

```bash
export CHRONARY_API_KEY="$(npx -y @chronary/agent-init@latest --email you@example.com --otp 123456)"
```

The key is printed on stderr (`export CHRONARY_API_KEY=...`) as soon as the
sign-up returns it, before the OTP is read. It is the only copy: running the
sign-up again for an email that is not verified yet sends a new code but
returns no key. If the OTP is missing or wrong, or the calendar step fails,
keep that key and finish with `--verify-only`. If the code expired (60
minutes) or too many tries used it up, run the sign-up again with the same
email: it prints no key but emails a new code, and the first key stays valid.
Then run `--verify-only` with the new code.

## Non-interactive flow (CI / Claude Code / Cursor)

The OTP does not exist until the sign-up sends it, so a run with no TTY takes
two steps:

```bash
# 1. Sign up. Exits 2 after printing the key on stderr (no TTY, no OTP).
CHRONARY_EMAIL=you@example.com npx @chronary/agent-init@latest

# 2. With the code from the email (valid for 60 minutes):
CHRONARY_API_KEY=chr_sk_... CHRONARY_OTP=123456 \
  npx @chronary/agent-init@latest --verify-only
```

Never blocks waiting for a TTY prompt that won't come — if `stdin.isTTY` is
false and `CHRONARY_OTP` is unset, the process exits 2 with a clear message.
`--verify-only` reads the key from `CHRONARY_API_KEY` only (never argv), does
no sign-up, and prints the key last on stdout like a full run. It ignores
`CHRONARY_EMAIL` / `CHRONARY_ANONYMOUS` left in the environment; only an
explicit `--email` / `--anonymous` flag is refused.

## No email: a claimable calendar (`--anonymous`)

When no inbox is available, you can sign up without an email:

```bash
npx -y @chronary/agent-init@latest --anonymous
```

1. `POST /v1/agent/sign-up/anonymous` creates a claimable organization. Its key works at once, at Sandbox limits.
2. `POST /v1/calendars` creates the smoke calendar, which is the plan's one calendar.

As soon as the sign-up answers, the command prints the key, a **claim link** and the **expiry** on stderr. A failed smoke calendar after that is only a warning: the key and the link stay valid. Give the claim link to the person who should own the calendar. When they open it while signed in to the [Chronary console](https://console.chronary.ai), the agent, calendar and events move into their account, and this key stops working. The link works once.

If nobody claims the calendar within 72 hours, the key stops working and the organization and its data are deleted.

Restrictions:
- The organization sends and receives no email.
- It cannot create webhook endpoints.
- `--email` / `--otp` cannot be combined with `--anonymous`.

When `--anonymous` is not available on an API (`503 anonymous_signup_disabled`), sign up with `--email` instead. The claimable calendars guide covers the details: https://docs.chronary.ai/guides/claimable-calendars/

To keep the claim link when you capture stdout, add `--json`:

```bash
npx -y @chronary/agent-init@latest --anonymous --json
# {"api_key":"chr_sk_...","org_id":"...","agent_id":"agt_...","calendar_id":"cal_...","claim_url":"https://console.chronary.ai/claim/anonymous#token=...","expires_at":"..."}
```

Signing up (either flow) accepts the [Terms of Service](https://chronary.ai/terms) for the person or organization you act for.

## Flags

| Flag | Env | Default | Purpose |
| --- | --- | --- | --- |
| `--email` | `CHRONARY_EMAIL` | _(required unless `--anonymous`)_ | Email to register |
| `--otp` | `CHRONARY_OTP` | stdin prompt | 6-digit OTP (verify step) |
| `--anonymous` | `CHRONARY_ANONYMOUS=1` | off | Sign up with no email (claimable, 72 h) |
| `--verify-only` | _(key in `CHRONARY_API_KEY`)_ | off | Finish an email sign-up that stopped before verify: verify + smoke calendar, no sign-up |
| `--json` | `CHRONARY_JSON=1` (shell version only) | off | One JSON line on stdout instead of the bare key |
| `--api` | `CHRONARY_API` | `https://api.chronary.ai` | API base URL |
| `--agent-name` | `CHRONARY_AGENT_NAME` | `Bootstrap Agent` | Display name |
| `--tos-version` | `CHRONARY_TOS_VERSION` | _(fetched live)_ | Pin a ToS version. A pinned version is never swapped: if it is out of date, the command exits 1 and names the current one |

## Shell fallback (no Node)

If `npx` isn't available, the equivalent shell script is:

```bash
curl -sSfL https://chronary.ai/agent-init.sh | CHRONARY_EMAIL=you@example.com sh
# or, with no email (claimable):
curl -sSfL https://chronary.ai/agent-init.sh | CHRONARY_ANONYMOUS=1 sh
# one JSON line on stdout, like --json:
curl -sSfL https://chronary.ai/agent-init.sh | CHRONARY_ANONYMOUS=1 CHRONARY_JSON=1 sh
```

The shell version is intentionally a 1:1 mirror of this package — same env
vars, same exit codes. Use whichever your environment makes easiest.

## Why a separate package?

`@chronary/sdk` is for application code — it has methods like
`client.calendars.create(...)` you build on. `@chronary/agent-init` is a
one-shot CLI: it provisions credentials and exits. Bundling the two would
balloon the `npx`-resolve cost for cold agents that just need a key.

## Differences from `chronary.ai/install.sh`

| Artifact | What it installs |
| --- | --- |
| `chronary.ai/install.sh` | Go-based `chronary` CLI binary (developer tool) |
| `npx @chronary/agent-init` | Agent **identity** (API key + smoke calendar) |
| `chronary.ai/skills.sh` | IDE skill packs for Claude Code / Cursor / etc. |

They're complementary. A cold agent typically wants `agent-init` + `skills.sh`.

## License

Apache-2.0.
