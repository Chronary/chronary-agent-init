# `@chronary/agent-init`

One-liner bootstrap for AI agents on Chronary.

```bash
npx @chronary/agent-init@latest
```

In ~5 seconds the script does this:

1. `POST /v1/agent/sign-up` — provisions a new org + restricted API key
2. Reads the OTP from `CHRONARY_OTP` env, `--otp` flag, or stdin (TTY only)
3. `POST /v1/agent/verify` — upgrades the key to the full Free-tier plan
4. `POST /v1/calendars` — creates a smoke calendar to prove write access works

The last line of stdout is the new API key, so it composes:

```bash
export CHRONARY_API_KEY="$(npx -y @chronary/agent-init@latest --email you@example.com --otp 123456)"
```

## Non-interactive flow (CI / Claude Code / Cursor)

```bash
CHRONARY_EMAIL=you@example.com \
CHRONARY_OTP=123456 \
  npx @chronary/agent-init@latest
```

Never blocks waiting for a TTY prompt that won't come — if `stdin.isTTY` is
false and `CHRONARY_OTP` is unset, the process exits 2 with a clear message.

## Flags

| Flag | Env | Default | Purpose |
| --- | --- | --- | --- |
| `--email` | `CHRONARY_EMAIL` | _(required)_ | Email to register |
| `--otp` | `CHRONARY_OTP` | stdin prompt | 6-digit OTP (verify step) |
| `--api` | `CHRONARY_API` | `https://api.chronary.ai` | API base URL |
| `--agent-name` | `CHRONARY_AGENT_NAME` | `Bootstrap Agent` | Display name |
| `--tos-version` | `CHRONARY_TOS_VERSION` | _(fetched live)_ | Override ToS version |

## Shell fallback (no Node)

If `npx` isn't available, the equivalent shell script is:

```bash
curl -sSfL https://chronary.ai/agent-init.sh | CHRONARY_EMAIL=you@example.com sh
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
