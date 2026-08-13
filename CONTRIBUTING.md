# Contributing

## Development

```sh
npm install
npm run typecheck
npm test        # runs against a scripted fake runtime; no network or model needed
npm run build
```

## Releasing (maintainers)

Releases publish through [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): the npm package is bound to this GitHub repository's `release.yml` workflow, so CI holds no npm token at all.

One-time setup (a trusted publisher can only be configured on an existing package):

1. Bootstrap release from a maintainer machine (needs publish rights in the `openma` npm org):

   ```sh
   npm login
   npm publish --no-provenance   # provenance is CI-only; skip it for this one publish
   ```

2. On npmjs.com → package → **Settings → Trusted publisher**: select **GitHub Actions**, organization `openma-ai`, repository `deepseek-harness-typescript-sdk`, workflow filename `release.yml`, environment empty.

Cutting a release (everything after the bootstrap):

```sh
npm version patch   # or minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Pushing the `v*` tag triggers [`release.yml`](.github/workflows/release.yml): it type-checks, runs the test suite, verifies the tag matches `package.json`, and runs `npm publish` — authenticated via the OIDC trusted-publisher exchange, with provenance and public access coming from `publishConfig`.
