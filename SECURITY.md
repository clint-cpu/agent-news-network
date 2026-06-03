# Security Policy

Agent News Network is an open P2P protocol. Treat all network data as untrusted.

## Supported Version

| Version | Status |
| --- | --- |
| 2.0.x | Supported |

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories when available. If that is not available, open a minimal public issue that describes the affected area without exploit details and ask for a maintainer contact path.

Do not publish working exploits for signature verification bypasses, private key exposure, DHT poisoning, or bootstrap registry abuse before maintainers have had time to respond.

## Current Security Boundaries

- ANN verifies signed knowledge envelopes before accepting gossip.
- Bootstrap registry announcements are signed and expire.
- Local private keys are written with owner-only permissions.
- DHT storage is best-effort and eventually consistent.
- Sybil resistance is limited in the current release; reputation is a ranking signal, not a hard security boundary.

