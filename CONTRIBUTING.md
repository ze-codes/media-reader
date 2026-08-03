# Contributing to Media Reader

Thanks for helping improve Media Reader. Keep changes focused, reviewable, and
safe for a public, single-user self-hosted project.

## Development setup

Install [Bun](https://bun.sh/) at the version used by CI, then install the
locked dependency graph:

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run doctor
```

Populate only the local settings you need. Never commit `.env`, provider or
OAuth credentials, cookie exports, runtime databases, uploads, generated
articles, transcripts, model files, or caches.

Media Reader accepts provider model IDs supplied by each user. Contributions
must pass those IDs through as configuration; do not introduce a personal
default, hidden allowlist, or repository-wide provider/model choice.

## Tests and public checks

Run the relevant focused tests while developing and the complete public checks
before opening a pull request:

```sh
bun test
bun run smoke:public
bun run audit:public
bun run audit:public -- --history
```

The public smoke is offline and must not require credentials, cookies, private
mounts, a live database, or real user content.

Browser QA requires Playwright and its Chromium browser. After the locked Bun
install, install the browser binary if it is not already present:

```sh
bunx playwright install chromium
./ops/ui-test.sh
```

The default browser run uses isolated fixtures. Live integration is opt-in and
must use a local or otherwise authorized test instance with non-sensitive test
media:

```sh
MEDIA_READER_BASE_URL=http://127.0.0.1:8099 \
MEDIA_READER_TEST_VIDEO_URL=https://www.youtube.com/watch?v=public-test-id \
MEDIA_READER_RUN_INTEGRATION_UI=1 \
./ops/ui-test.sh
```

## Contribution scope

- Keep pull requests focused on one behavior or cohesive change.
- Explain user-visible behavior, migration impact, and tests performed.
- Add or update focused tests for behavior changes.
- Keep schema migrations additive and idempotent so repeated startup is safe.
- Preserve backward compatibility unless a breaking change is explicitly
  approved and documented.
- Keep deployment-specific hostnames, routes, tokens, mounts, and owner
  defaults outside the reusable public core.

## Fixture and privacy rules

Fixtures, screenshots, logs, issue reports, and test artifacts must not contain
real user media, titles, transcripts, generated articles, cookies, credentials,
private environment values, or identifying account data. Use small synthetic
fixtures or public test sources that are explicitly approved for that purpose.
Redact secrets and user content before sharing failure output.
