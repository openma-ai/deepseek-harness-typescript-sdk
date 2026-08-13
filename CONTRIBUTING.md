# Contributing

## Development

```sh
npm install
npm run typecheck
npm test        # runs against a scripted fake runtime; no network or model needed
npm run build
```

## Releasing (maintainers)

One-time setup:

1. Create the `openma` org on [npmjs.com](https://www.npmjs.com) (free; scoped packages must be public).
2. Generate a **granular access token** (Packages: Read and write, scoped to `@openma`) and store it as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).
3. Optional, after the first release: configure npm **Trusted Publishing** on the package (Settings → Trusted publisher → GitHub Actions, repo `openma-ai/deepseek-harness-typescript-sdk`, workflow `release.yml`), then delete `NPM_TOKEN` and the `NODE_AUTH_TOKEN` line in the workflow — OIDC (`id-token: write`) takes over.

Cutting a release:

```sh
npm version patch   # or minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Pushing the `v*` tag triggers [`release.yml`](.github/workflows/release.yml): it type-checks, runs the test suite, verifies the tag matches `package.json`, and runs `npm publish` (provenance and public access come from `publishConfig`).
