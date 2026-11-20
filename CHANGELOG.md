# @chronary/agent-init — Changelog

## 0.2.0 (unreleased)

- `--anonymous` (or `CHRONARY_ANONYMOUS=1`) signs up without an email or OTP
  (#2335). It calls `POST /v1/agent/sign-up/anonymous`, which creates a
  claimable organization whose key works at once at Sandbox limits. As soon as
  the sign-up answers, it prints three things:
  - the key;
  - the one-time claim link, for the person who should own the calendar;
  - the expiry (72 hours; unclaimed, the key stops working and the data is
    deleted).

  It then creates the smoke calendar. If that fails, it prints a warning and
  still exits 0 with the key on stdout.

  With a Terms version it read itself, it retries once on a 409
  `tos_version_stale` with the current version. A version you pinned
  (`--tos-version` / `CHRONARY_TOS_VERSION`) is never swapped: it exits 1
  and names the current version. A per-network budget 429 with a long
  `Retry-After` is reported instead of waited out. A 503 explains why there
  was no key: switched off, so use `--email`, or paused. `--anonymous`
  together with an email or OTP exits 2.
- `--json` prints one JSON line on stdout instead of the bare key:
  - email flow: `api_key`, `org_id`, `agent_id`, `calendar_id`;
  - with `--anonymous`, also `claim_url` and `expires_at`. `calendar_id` is
    `null` when the smoke calendar failed.

  A caller that captures stdout then keeps the claim link.
- `--help` says that signing up accepts the Terms of Service.

## 0.1.5 (2026-11-13)

- A 429 `quota_exceeded` is no longer retried, and a `Retry-After` longer than
  60 seconds is capped at 60, like every Chronary SDK (#1936).

## 0.1.4 (2026-11-09)

- When sign-ups are paused, the API answers with HTTP 202 `{ waitlisted: true, message }`
  and no key. agent-init now reports that message instead of a generic
  "Sign-up failed: HTTP 202" (#1655).

## 0.1.2 (2026-05-30)

- Fix `repository.url` in package.json — was pointing at the wrong mirror
  (`chronary-cli`) because of a copy-paste from the MCP scaffold; now points
  at `chronary-agent-init`. npm's OIDC provenance verifier rejected 0.1.1
  with E422 because the in-tarball `repository.url` didn't match the GitHub
  repo that signed the Sigstore bundle. 0.1.2 is the first version with a
  consistent provenance attestation.

## 0.1.1 (2026-05-29)

- First version to ship via OIDC trusted publishing with Sigstore provenance.
  0.1.0 was the manual bootstrap publish from local (classic token, no
  provenance) — npm has no Pending Publisher flow, so the first publish has
  to claim the package name before Trusted Publisher can be registered.
  Trusted Publisher is now registered on npmjs.com for `@chronary/agent-init`
  against `Chronary/chronary-agent-init` + `release-artifact.yml`.

  Same pattern as the toolkit / schemas / mcp 0.1.2 → 0.1.3 rounds.

## 0.1.0 (2026-05-29)

Initial release.

- `chronary-agent-init` bin: sign-up → OTP verify → smoke calendar in one shot
- Env-var driven (`CHRONARY_EMAIL`, `CHRONARY_OTP`); never blocks on a missing TTY
- 429 backoff with up to 3 retries
- Last line of stdout is the API key, so the script composes:
  ```bash
  export CHRONARY_API_KEY="$(npx -y @chronary/agent-init@latest --email you@example.com --otp 123456)"
  ```
- Apache-2.0 license

Tracks [#754](https://github.com/Chronary/chronary/issues/754) Phase 2.
