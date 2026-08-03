# Media Reader Roadmap

This checklist records the agreed product sequence. The immediate goal is a
credible open-source, single-user release. A paid hosted service follows only
after real usage and model-cost data exist.

## Product Decisions

- [x] Build and publish the self-hosted edition before building hosted billing.
- [x] Keep the article transformation faithful and minimally compressed.
- [x] Exclude YouTube Shorts.
- [x] Support OpenRouter in the first open-source release.
- [x] Support configurable OpenAI-compatible endpoints in the first release.
- [x] Support OpenAI OAuth through an authenticated official Codex CLI adapter.
- [x] Support Anthropic OAuth through an authenticated official Claude Code CLI adapter.
- [x] Keep provider authentication local in self-hosted installations; Media Reader must not implement or store provider OAuth refresh tokens itself.
- [x] Present timestamped speech in a dedicated `Transcript` tab beside the clean `Article` view.
- [x] Create timestamp links only from source-provided timed transcript cues; never infer or align timestamps with an LLM.
- [x] Treat Whisper's native segment start/end output as valid timing data.
- [x] Make native host execution the primary open-source installation so official Codex and Claude Code OAuth sessions remain local.
- [x] Keep Docker as a secondary API-provider deployment and use containers only for optional helper services where useful.
- [ ] Owner decides whether to publish a clean public snapshot or retain the audited existing history; no repository strategy is approved yet.
- [ ] Retire the private runtime profile only after the native public runtime handles the owner's production library reliably and the owner approves removal.
- [x] Build the later hosted service as a managed layer over the same public core, not as a second implementation.
- [x] Use `/docker/media-reader` as an umbrella containing `app`, `private`, `runtime`, and future `hosted` boundaries.
- [x] License the open-source project under the permissive MIT license.
- [x] Let each self-hosting user select and persist their own provider and model; do not enforce a product-wide model.
- [x] Accept an explicit OpenRouter model ID from the user; do not fetch, curate, or hard-code an OpenRouter model catalog.
- [x] Plan a paid subscription product for the later hosted edition rather than hosted BYOK.

## 1. Finish The Reading Experience

- [ ] On mobile article pages, hide both the global header and reader toolbar while scrolling down.
- [ ] Restore both bars when scrolling up or returning near the top.
- [ ] Keep the thin reading-progress indicator visible while the bars are hidden.
- [ ] Respect reduced-motion preferences and prevent header movement from changing saved reading progress.
- [ ] Store timestamped transcript segments rather than only flattened transcript text.
- [ ] Show timestamps in the transcript and link each timestamp to the source video at that position.
- [ ] Preserve timestamps from TranscriptAPI, YouTube captions, and Whisper wherever the source provides them.
- [ ] Keep transcripts readable but unlinked when the source or a legacy row has no timing data.

## 2. Decouple The LLM Runtime

- [ ] Define one provider-neutral article-generation interface with structured output, usage, cost, timeout, and error metadata.
- [ ] Remove the open-source runtime's dependency on `/docker/infra`, `llm-client.mjs`, and the private `llm-engine` service.
- [ ] Add an OpenRouter adapter with a user-supplied model ID, validation, and actual usage-cost capture.
- [ ] Add a configurable OpenAI-compatible adapter: base URL, API key, model, and optional headers.
- [ ] Add a Codex CLI adapter that relies on the official CLI's existing OpenAI login and credential store.
- [ ] Add a Claude Code CLI adapter that relies on the official CLI's existing Anthropic login and credential store.
- [ ] Never read, copy, expose, or reimplement either CLI's stored OAuth tokens.
- [ ] Add provider diagnostics that test connectivity without printing credentials.
- [ ] Document capability differences and failure modes for API and CLI providers.

## 3. Evaluate OpenRouter Models

- [ ] Build a fixed evaluation corpus from representative short, long, Chinese, interview, lecture, and repetition-heavy transcripts.
- [ ] Compare three to four candidate models using the production article prompt.
- [ ] Score factual fidelity, topic coverage, ordering, shrinkage, prose quality, JSON reliability, latency, and actual cost.
- [ ] Keep source transcripts and evaluation outputs private unless explicitly cleared for publication.
- [ ] Publish the tested model IDs and their quality, latency, and cost results as documentation only.
- [ ] Re-run the evaluation when the prompt or default model changes materially.

## 4. Package The Open-Source Release

- [ ] Prepare the owner-approved public repository strategy (clean snapshot recommended; existing-history retention remains an explicit tradeoff).
- [ ] Create `/docker/media-reader/private` for Media Reader-specific OverDrive deployment configuration and ignored credentials.
- [ ] Move live database, uploads, cache, and model data into `/docker/media-reader/runtime` during an owner-present migration.
- [ ] Reserve `/docker/media-reader/hosted` for the later managed-service repository; do not scaffold hosted code now.
- [ ] Provide a native single-user setup as the primary installation path, including a dependency check and service definition.
- [ ] Let the native app use official host-installed Codex and Claude Code CLIs without reading or copying their credentials.
- [ ] Document host dependencies for Bun, yt-dlp, ffmpeg, Whisper, and optional YouTube helper services.
- [ ] Provide a secondary Docker Compose deployment for OpenRouter and OpenAI-compatible API providers with persistent data volumes.
- [x] Add `.env.example` entries for OpenRouter, OpenAI-compatible endpoints, TranscriptAPI, and local runtime settings.
- [x] Make TranscriptAPI optional and retain caption and local Whisper fallbacks.
- [ ] Add startup validation with actionable configuration errors.
- [ ] Document installation, provider setup, data ownership, backups, updates, and troubleshooting.
- [x] Add sample data or a smoke workflow that does not use private content or credentials.
- [x] Add the MIT license file and retain required third-party notices.

## 5. Public-Release Audit

- [x] Scan the current tree and complete Git history for high-confidence secrets and private user-data indicators with redacted output.
- [x] Remove private hostnames, internal routes, Telegram hooks, personal defaults, and infrastructure-only assumptions from current public operations.
- [x] Confirm runtime databases, uploads, cookies, transcripts, generated articles, logs, and evaluation artifacts are ignored.
- [x] Audit dependency licenses and generated/vendor files.
- [x] Add CI for tests, redacted tree/history secret scanning, and the credential-free public smoke.
- [x] Add the public-release audit record and owner-gated checklist.
- [x] Document the product, sanitized public operations, contribution posture, and security reporting path.
- [ ] Validate a frozen-lockfile install, tests, and smoke from a fresh isolated checkout or snapshot.
- [ ] Capture and privacy-review public release screenshots using synthetic or explicitly approved content.
- [ ] Have the owner choose clean snapshot versus existing history and approve the public source boundary.
- [ ] Create or expose the owner-approved public repository, push the snapshot, and tag/release it.
- [ ] Perform the owner-present live migration and routed production verification.
- [ ] Retire the temporary private adapter only after routed proof and explicit owner approval.
- [x] Add `media-reader` to the guarded orchestrator's repo routing before implementation tickets are dispatched.

## 6. Hosted Subscription Edition - Later

- [ ] Revisit hosted scope after open-source adoption and model evaluation produce real usage data.
- [ ] Add account authentication and strict tenant ownership for every channel, video, transcript, article, upload, job, and reading-progress row.
- [ ] Use dedicated service API credentials with provider budgets; never fall back to personal or private shared-engine credentials.
- [ ] Add subscription billing, entitlements, cancellation, failed-payment handling, and webhook reconciliation.
- [ ] Meter LLM inference, TranscriptAPI usage, Whisper compute, storage, uploads, and bandwidth per account.
- [ ] Set plan allowances from measured cost percentiles and preserve a margin for long-tail articles.
- [ ] Add per-user queues, rate limits, concurrency limits, storage quotas, deletion, and export.
- [ ] Complete privacy, abuse, retention, support, and operational policies before public signup.
- [ ] Keep hosted-only identity, billing, abuse controls, and operations outside the reusable public core.

## Decisions Still Needed

- [ ] Select the first OpenRouter model candidates and evaluation acceptance thresholds for published guidance, not enforcement.
- [ ] Set hosted subscription tiers only after the OpenRouter evaluation and public usage data are available.
