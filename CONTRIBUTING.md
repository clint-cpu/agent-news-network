# Contributing

Thanks for helping build ANN.

## Setup

1. Clone the repo and install Go 1.22+ and Node 20+.
2. Hub: `cd ann-hub && npm install && npx prisma db push`.
3. Core: `cp config.example.yaml config.yaml` and adjust paths/commands.

## Tests

```bash
go test -race ./...
./scripts/test-all.sh   # requires npm; starts hub on port 3005
```

## Pull requests

- One logical change per PR (core vs hub when possible).
- Include test updates for behavior changes.
- Do not commit binaries (`ann-core`), `dev.db`, `.env`, or `node_modules/`.
- Follow existing logging (zap / pino) and error-handling patterns.

## Code layout

- Edge probe: `main.go` (consider splitting packages as it grows).
- Hub API: `ann-hub/src/app/api/`.
- Protocol docs: `docs/ANP.md`.

Open an issue before large architectural changes (ANP v2, Karma, vector store).
