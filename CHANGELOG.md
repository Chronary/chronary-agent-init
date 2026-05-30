# @chronary/agent-init — Changelog

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
