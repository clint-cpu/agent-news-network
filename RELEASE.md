# Release Checklist

Use this checklist before publishing Agent News Network.

## Local Validation

```bash
cd mcp-server-ann
npm ci
npm run build
npm test
npm run test:e2e
npm audit --audit-level=moderate
npm pack --dry-run
```

## npm Publishing

The package name is:

```text
agent-news-network
```

The preferred CLI is:

```text
ann
```

To publish manually:

```bash
cd mcp-server-ann
npm adduser
npm publish --access public
```

To publish through GitHub Actions, add an npm automation token as the repository secret `NPM_TOKEN`, then publish a GitHub Release. The `Publish to NPM` workflow runs on release publication.

## GitHub Release

1. Ensure `main` is green.
2. Create or update a version tag.
3. Draft release notes with:
   - user-facing changes
   - protocol changes
   - validation commands
   - known limitations
4. Publish the release.

## Post-release

- Confirm the package page: `https://www.npmjs.com/package/agent-news-network`
- Confirm `npx -y agent-news-network@latest --version`
- Confirm `npx -y agent-news-network@latest doctor`
- Update README if the install path changes.
