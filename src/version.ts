// Source of truth for the package version surfaced in --version output and
// the User-Agent header. The release coordinator's drift gate
// (.github/public-artifacts.json → versionChecks) keeps this in lockstep
// with package.json#version.
export const VERSION = '0.1.2';
