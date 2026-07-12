# On-premise infrastructure

The Compose definition is a development and controlled-VM baseline, not a production sizing claim. Production uses separate DMZ, application, data, and management VLANs as specified in the Phase 0 architecture.

## Image supply chain

All images must be mirrored into NIET's Harbor registry, pinned by digest, scanned, signed, and approved before deployment. Copy `compose/.env.example` to a protected environment file and replace the `:approved` placeholders with immutable digests.

## Secrets

Secrets are files outside the repository. The example expects a root-readable directory containing one value per named secret. Production should use NIET's approved on-premise secrets/KMS service and short-lived workload credentials where supported.

## Network posture

The Compose networks are internal by default and publish no ports. A separately managed reverse proxy/WAF is the only public entry point. Operators may add loopback-only development port bindings in an untracked override file; those bindings must never be copied to production.

## Operations gate

Do not report this stack as production-ready until NIET has selected approved images, completed capacity tests, configured HA nodes and certificates, exercised backup restoration, and verified monitoring and incident runbooks.

