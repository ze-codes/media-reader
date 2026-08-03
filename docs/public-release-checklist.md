# Public-Release Checklist

Checked items are supported by evidence at the MAI-414 checkpoint. Unchecked
items have not been performed or still require an owner decision. Completing
documentation does not authorize a release operation.

## Audit and source boundary

- [x] Audit the tracked tree and all reachable history with redacted output.
- [x] Record credential/runtime-data results separately from non-secret author
  metadata and internal references.
- [x] Remove private hosts, tokens, infrastructure coupling, Telegram hooks,
  and personal defaults from current public operations.
- [x] Use generic `MEDIA_READER_BASE_URL` workflows and explicit test inputs.
- [ ] Have the owner choose a clean public snapshot or retention of the audited
  existing history.
- [ ] Assemble and review the owner-approved public source boundary. A clean
  snapshot excludes internal plans under `docs/superpowers/` and the owner
  migration runbook at `docs/workspace-migration.md`; it does not delete them
  from the private development repository.

## Reproducibility and verification

- [ ] From a fresh, isolated checkout or snapshot, run
  `bun install --frozen-lockfile` without private mounts or caches.
- [ ] Run `bun test` in that clean environment.
- [ ] Run `bun run smoke:public` in that clean environment.
- [ ] Run `bun run audit:public` and
  `bun run audit:public -- --history` against the exact release source.
- [ ] Run the opt-in Playwright browser checks against a generic local route
  with synthetic or explicitly approved test media.
- [ ] Rehearse the complete self-host setup on a fresh machine or isolated
  environment, including provider configuration and writable runtime paths.

## Licensing and release materials

- [x] Include the MIT `LICENSE` and `THIRD_PARTY_NOTICES.md` for direct and
  vendored dependencies.
- [x] Document product scope, self-hosting, public tests, audit commands,
  contribution policy, security reporting, and release gates.
- [ ] Capture and privacy-review release screenshots using synthetic or
  explicitly approved content.
- [ ] Confirm every README command and screenshot matches the exact release
  snapshot.

## Owner-controlled publication

- [ ] Confirm the private development repository remains retained and backed
  up regardless of the public-history decision.
- [ ] Create a separate public repository or change existing repository
  visibility, according to the owner's explicit decision.
- [ ] Push the owner-approved public source.
- [ ] Configure and verify a private maintainer security-contact path; enable
  GitHub private vulnerability reporting when available.
- [ ] Create the release tag and release notes.
- [ ] Publish the release.

## Separate live migration and retirement gates

- [ ] Schedule the owner-present live workspace/data migration and complete all
  preflight, backup, rehearsal, rollback, and routed verification steps in
  `docs/workspace-migration.md`.
- [ ] Retire any temporary private adapter only after the replacement public
  adapter passes routed production proof and the owner approves removal.

This checklist grants no permission to change visibility, create a repository,
rewrite history, push, migrate live data, remove an adapter, or delete files.
