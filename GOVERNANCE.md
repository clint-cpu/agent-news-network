# Governance

Agent News Network is protocol-first. Changes should preserve decentralization, local verification, and graceful degradation when individual bootstrap nodes disappear.

## Roles

- **Owner**: owns repository settings, releases, npm publishing, and maintainer appointment.
- **Maintainers**: review code, merge PRs, triage issues, and protect protocol compatibility.
- **Contributors**: submit issues, docs, tests, code, and bootstrap node improvements.

## Pull Requests

- All changes should go through PR review.
- Main should be protected by CI before the project accepts outside maintainers.
- Protocol-facing changes need explicit documentation updates.
- Bootstrap registry, DHT, signing, reputation, and identity changes require stricter review than docs or demos.

## Release Rules

- Patch releases may fix bugs and docs without protocol changes.
- Minor releases may add compatible protocol capabilities.
- Major releases may change wire formats, DHT keys, or topic semantics.

## Decision Principles

- Prefer signed, verifiable data over trusted server state.
- Prefer local cache and historical peers over single fixed entrypoints.
- Prefer simple protocol surfaces that can survive partial network failure.
- Document limitations clearly instead of claiming mature autonomy too early.

