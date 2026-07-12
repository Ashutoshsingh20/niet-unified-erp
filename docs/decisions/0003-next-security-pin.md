# ADR 0003: Temporary patched Next.js canary pin

- Status: Temporary; must be replaced before production approval
- Date: 2026-07-13

## Context

The current stable Next.js package pins PostCSS 8.4.31, which is affected by `GHSA-qx2v-qp2m-jg93`. npm overrides cannot replace that exact nested dependency safely. The first available Next.js package in the current registry that pins patched PostCSS 8.5.10 is `16.3.0-canary.6`.

## Decision

Pin Next.js exactly to `16.3.0-canary.6` during Phase 1 rather than accepting a known XSS advisory. Do not float to later canary builds. Keep dependency audit as a required gate.

## Consequences

- The web foundation has no known npm audit finding at this checkpoint.
- Canary framework risk remains and prevents production approval.
- Replace this pin with the first compatible stable Next.js release that includes PostCSS 8.5.10 or newer, rerun the full web suite, OIDC flow, CSP validation, and accessibility checks, then update this ADR.

