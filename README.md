# Media Reader

Turn media sources into readable articles. Drop in a YouTube channel, YouTube video, Xiaohongshu note URL, or local media file; the service gets or creates a transcript and runs it through the configured generation provider to produce a TL;DR plus long-form article. The browser UI has one URL input that routes channel URLs and single-video URLs automatically, plus local file upload.

Media Reader is for turning long audio/video material into something you can scan, read, save, and reuse. The product is **not just a transcript downloader**. Transcript retrieval is an internal step; the user-facing output is an edited article with a TL;DR, source metadata, generation cost, and quick copy actions.

## Product experience

The primary workflow is intentionally small:

1. Paste one URL or upload one media file.
2. Media Reader resolves the source and queues work.
3. The worker reuses a stored transcript, then tries TranscriptAPI for YouTube before direct captions or Whisper fallbacks.
4. The LLM turns the transcript into a readable article that preserves the speaker's substance while removing filler.
5. The reader opens the result, scans the TL;DR, reads the full article, or copies either section as markdown.

The UI groups work by source, shows per-video state, and streams progress live. Existing results stay in SQLite, so the app behaves more like a personal article library than a one-shot conversion tool.

## Current capabilities

| Input | Product behavior |
|---|---|
| YouTube channel or `@handle` | Lists long-form uploads, skips Shorts, queues each video, and tracks done/error counts for the source. |
| YouTube video URL | Resolves and queues one video without crawling the whole channel; Short URLs are rejected. |
| Xiaohongshu note URL | Resolves one note/video and transcribes via audio when captions are unavailable. |
| Local audio/video upload | Stores the file under local uploads, transcribes it with Whisper, and generates the same article format. |

Generated results include:

- TL;DR markdown bullets.
- Full article markdown with headings.
- Transcript source label: captions, TranscriptAPI, Whisper, or stored transcript.
- Model, estimated token usage, and estimated cost.
- Retry and delete controls.
- Copy buttons for TL;DR and full article markdown.
- A paginated reading list with persisted read/unread state and source filters.
- Publication dates plus database-backed reading progress that restores the reader's last scroll position.
- A manual YouTube access reload action that rereads mounted cookies and retries authentication-blocked videos.

## Product boundaries

- This is optimized for long-form informational media. YouTube Shorts are excluded from imports and direct submissions.
- The article should preserve meaning and coverage; it is not meant to be a tiny abstract.
- YouTube channel crawling is supported; Xiaohongshu creator/profile crawling is not.
- If a YouTube video has no API transcript or usable captions and audio download is blocked, only that video errors; other YouTube jobs continue.
- The public edition is a single-user self-hosted app. Put an authentication-aware reverse proxy in front of it before exposing it beyond a trusted host.

## Pipeline

```
                    Video source             Article + TL;DR
                         │                          ▲
                         ▼                          │
                  ┌────────────┐                    │
                  │ Resolve /  │                    │
                  │ list videos│                    │
                  └──────┬─────┘                    │
                         │                          │
                         ▼                          │
                  ┌────────────┐                    │
                  │  Fetch     │ ──── captions ───┐ │
                  │ transcript │                  │ │
                  └──────┬─────┘                  │ │
                         │ no captions            │ │
                         ▼                        ▼ │
                  ┌────────────┐           ┌──────────┐
                  │  Whisper   │ ────────▶ │   LLM    │
                  │ transcribe │           │ transform│
                  └────────────┘           └──────────┘
```

Transcript acquisition is best-effort and layered: reuse a stored transcript, try TranscriptAPI first for YouTube, then platform captions, then Whisper transcription from audio.

## High-level architecture

```text
 Browser ─────── HTTP / SSE ───────┐
   ▲                               ▼
   │                    ┌─────────────────────┐
 optional               │ Media Reader       │
 auth proxy             │ Bun + Express      │
                        │ API + worker loop   │
                        └──────┬──────────────┘
                               │
                  ┌────────────┼──────────────┐
                  ▼            ▼              ▼
               SQLite       yt-dlp         provider
             + uploads   + Whisper      HTTP or CLI
```

The public app has no required proxy, container network, or private source-code
mount. A self-hoster can run it directly on a trusted machine or place any
authentication-aware reverse proxy in front of its HTTP port. SQLite, uploads,
caches, and model files stay under the configured data directory.

The whole thing is one Bun process. `src/main.mjs` boots the DB, starts the Express server, and starts the worker loop in the same process. They share state via SQLite, so a crash mid-job does not lose the job: `resetInFlight()` rolls live states back to `queued` on startup.

## Per-video state machine

Every row in `videos` has a `state`. The worker pulls the oldest `queued` row and walks it through the pipeline.

```
                ┌─────────┐
        add ───▶│ queued  │◀─── retry button
                └────┬────┘
                     │  worker claims
                     ▼
                ┌──────────┐
                │ fetching │  yt-dlp + cookies → captions json3
                └────┬─────┘
                     │
                     ├── captions found ──┐
                     │                    │
                     ▼ no captions        │
                ┌─────────────┐           │
                │ transcribing│           │
                │  (whisper)  │           │
                └──────┬──────┘           │
                       │                  │
                       ├── audio + ASR ───┤
                       │                  │
                       ▼                  ▼
                       └────────┬─────────┘
                                ▼
                          ┌──────────┐
                          │ writing  │  LLM → tldr + article
                          └─────┬────┘
                                │
                       ┌────────┴────────┐
                       ▼                 ▼
                  ┌─────────┐       ┌─────────┐
                  │  done   │       │  error  │ (any stage fails)
                  └─────────┘       └─────────┘
```

Failure handling: any stage that throws sets `state = 'error'` and stores the message. The `/api/videos/:id/retry` endpoint (and the UI's retry button) put it back to `queued`.

## File map

| File / directory | Job |
|---|---|
| `src/main.mjs` | Boot: DB init, reset in-flight rows, start API + worker |
| `src/server/api.mjs` | Thin HTTP routes + SSE fan-out |
| `src/services/` | API orchestration: channel imports, single-video queueing, uploads, worker-status projection |
| `src/worker/worker.mjs` | Pulls queued videos and advances explicit pipeline stages |
| `src/ingest/index.mjs` | yt-dlp integration facade: list channel, resolve video, fetch captions, fetch audio, cookie state |
| `src/ingest/cache.mjs` | Per-video cache directory and cleanup helpers |
| `src/domain/` | Shared states, source detection, transcript quality checks, and SSE constants |
| `src/transcripts/transcript-api.mjs` | Primary hosted transcript source for YouTube |
| `src/transcripts/transcribe.mjs` | Transcription backend wrapper. Defaults to faster-whisper; can fall back to whisper.cpp |
| `src/transcripts/faster-whisper-transcribe.py` | CTranslate2/faster-whisper subprocess used by `src/transcripts/transcribe.mjs` |
| `src/llm/index.mjs` | Shared LLM engine client for the article transform; reads `src/llm/prompts/article.md` |
| `src/db/schema.sql` | Three tables: `channels`, `videos` (= job queue), `events` |
| `src/db/index.mjs` | Typed helpers around the schema |
| `src/shared/` | Runtime paths and DB-backed event logging |
| `public/index.html` + `public/*.mjs` | Single-page UI, API client, rendering helpers, SSE, state, upload progress |
| `tests/` | Bun unit tests for API projection, ingest helpers, DB helpers, LLM transform logic, upload storage, and frontend status labels |
| `scripts/` | Explicit-input operational scripts for article regeneration and prompt evaluation |
| `ops/` | Public test, deployment, and browser QA tooling; generated artifacts are ignored |

## Cookies

YouTube may block unauthenticated streaming, especially from datacenter IPs.
Cookies are optional and should be treated as credentials. Set
`MEDIA_READER_COOKIE_DIR` to any directory of Cookie-Editor JSON profiles that
the native runtime can read. If unset, the runtime falls back to `/cookies`.

File-cookie fallback:

1. Export YouTube cookies from a logged-in browser via the **Cookie-Editor** extension (JSON format).
2. Save the export in a local directory under a filename beginning with
   `youtube`.
3. Set `MEDIA_READER_COOKIE_DIR` to that directory. Native installs read it
   directly. Compose uses the same setting as the host side of a read-only bind,
   while the container reads the mounted profiles through its `/cookies`
   fallback.
4. `src/ingest/index.mjs` converts the selected JSON profile to Netscape format fresh on each yt-dlp call.

If direct YouTube audio access is blocked after TranscriptAPI and caption fallbacks fail, that video enters an error state instead of looping or pausing the whole queue. After renewing the cookie profile, use **Reload cookies** in the Media Reader sidebar. The server clears cached access flags, selects the uploaded profile ahead of a stale Chromium session, and retries only authentication-blocked videos; no service restart is required.

Xiaohongshu single-video support uses the same directory. Add a Cookie-Editor
JSON profile whose name starts with `xiaohongshu` (for example
`xiaohongshu.json`), and `src/ingest/index.mjs` will convert it to Netscape
format before each `yt-dlp` call.

### Per-video edge cases

- Many videos return no audio/video formats from YouTube's API (members-only, embed-restricted, etc.) but still expose captions. Both `resolveVideo` and `fetchCaptions` pass `--ignore-no-formats-error` so metadata + captions still come through.
- If an authenticated direct-audio URL returns HTTP 403 during a full transfer, audio extraction retries through the lowest-bandwidth `web_safari` HLS stream before failing the video.
- Some videos return without `channel_id` populated. `resolveVideo` falls back to a channel-page lookup via `uploader_url` to recover the UC id.
- A video with **no captions in any language AND blocked audio download** is unrecoverable with the current setup (would need a PO-Token plugin or residential proxy).
- Xiaohongshu currently supports **single note/video URLs only**. Creator/profile crawling is still YouTube-only, and Xiaohongshu generally goes straight to audio extraction + whisper rather than captions.

## URL and upload workflow

The UI has one URL input. It detects whether the URL is a single video/note or a channel/handle and sends it to the right endpoint. The backend also performs the same detection, so a single video pasted into the channel endpoint is still routed safely.

| Workflow | Endpoint | What it does |
|---|---|---|
| **Channel** | `POST /api/channels {url}` | Lists long-form videos on a **YouTube** channel via `yt-dlp --flat-playlist`, excludes Shorts, and queues the rest. Channel row gets `status='ready'`. |
| **Single video** | `POST /api/videos {url}` | Resolves one YouTube or Xiaohongshu video. Creates the parent row with `status='single'` if it doesn't exist (so we don't auto-crawl the rest). |
| **Upload** | `POST /api/uploads` | Stores one uploaded audio/video file, queues it under the local uploads channel, then transcribes it with Whisper. |

If you submit a single video for a channel that's already crawled, `upsertVideoQueued` is a no-op — same video id collides on `INSERT OR IGNORE`.

The article reader includes quick copy buttons for the TL;DR and full article markdown.
It saves normalized scroll progress to SQLite and restores that position when the article is reopened.

## Realtime updates

`src/worker/worker.mjs` and `src/server/api.mjs` share an in-process broadcaster (`setBroadcaster(broadcastSSE)`). Every state transition emits an SSE event over `/api/stream`. The UI debounces refreshes so rapid transitions don't thrash. On disconnect the client auto-reconnects every 3s.

## Running and self-hosting

Native installation is recommended for the `codex-cli` and `claude-cli` OAuth providers. Install and log in with the official CLI on the host, then let Media Reader invoke it as the same operating-system user. Media Reader uses only `codex login status` or `claude auth status` to check login and never reads or copies credential files. Containers are best suited to HTTP/API-key providers unless you deliberately bridge a host executable.

The complete native setup, data paths, Linux systemd example, macOS launchd guidance, optional TranscriptAPI/cookies, and troubleshooting guide is in [docs/self-hosting.md](docs/self-hosting.md).

For a native foreground run:

```sh
bun install --frozen-lockfile
bun run doctor
bun run start
```

`bun run doctor -- --json` emits automation-friendly diagnostics. Warnings for optional TranscriptAPI or cookies do not make it fail; required dependency, provider, authentication, or writable-path failures do. Doctor output contains no environment values, credential locations, raw provider status output, or command errors.

### Generation provider

Media Reader supports native Codex CLI and Claude Code CLI plus OpenRouter and generic OpenAI-compatible chat-completions endpoints through one provider-neutral contract. Set `LLM_PROVIDER` and paste the provider's model ID verbatim into `LLM_MODEL`. Media Reader does not fetch a model list or restrict model IDs.

Native Codex CLI:

```sh
codex login
LLM_PROVIDER=codex-cli
LLM_MODEL=your-codex-model
```

Native Claude Code CLI:

```sh
claude auth login
LLM_PROVIDER=claude-cli
LLM_MODEL=your-claude-model
```

Complete login separately through the official CLI before running doctor or starting Media Reader. `LLM_CODEX_BIN` and `LLM_CLAUDE_BIN` are optional executable overrides for services whose `PATH` does not include the official CLI.

OpenRouter:

```sh
LLM_PROVIDER=openrouter
LLM_MODEL=provider/model-id
LLM_API_KEY=replace-with-provider-key
```

`OPENROUTER_API_KEY` remains accepted as a migration alias. OpenRouter defaults to `https://openrouter.ai/api/v1`; `LLM_APP_URL` and `LLM_APP_NAME` optionally set its non-secret attribution headers.

Generic OpenAI-compatible endpoint:

```sh
LLM_PROVIDER=openai-compatible
LLM_MODEL=provider-model-id
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=replace-with-provider-key
```

The generic API key is optional for local endpoints that do not require authentication. When present, it is sent only in the `Authorization` header. Copy `.env.example` to a local `.env` for the complete variable surface; never commit the populated file or any CLI OAuth material.

For OpenRouter and OpenAI-compatible HTTP providers, the checked-in Compose
file is a secondary deployment option:

```sh
cp .env.example .env
docker compose up -d --build
```

Keep `.env`, runtime data, and cookie exports out of version control. Native
execution remains the supported path for host-installed OAuth CLIs; the public
container does not mount CLI credential stores or private infrastructure.

DB and transcription models live in `./data` (mounted into the container). Cache files (per-video captions/audio) live in `./data/cache/<videoId>/` and get cleared on retry/failure.

Default audio fallback is `faster-whisper` with `large-v3-turbo`, CPU `int8`, `beam_size=5`, and source-language transcription (`YT_FAST_WHISPER_TASK=transcribe`). The downstream LLM handles English article generation. Set `YT_TRANSCRIBE_BACKEND=whisper.cpp` to use the backup `whisper-cli` path.

## Test and smoke

```sh
bun test
bun run smoke:public
bun run audit:public
bun run audit:public -- --history
```

The public smoke imports direct dependencies, provider configuration, core
transcript/source modules, and checked-in browser assets. It does not read
`.env`, touch runtime data or cookies, start Docker, or call an external model.
`ops/smoke.sh` checks a running deployment through `MEDIA_READER_BASE_URL`,
defaulting to `http://127.0.0.1:8099`. It does not require a private hostname,
proxy token, or owner-specific infrastructure.

`audit:public` scans tracked current-tree content for high-confidence credential
patterns and emits redacted rule/path findings only. The `--history` mode scans
all reachable commits and adds commit identifiers without printing matched
values. Both modes run in CI from a full checkout. See the verified baseline in
[the public-release audit](docs/public-release-audit.md).

### Browser QA

Browser QA requires the Playwright package and a Chromium binary. The locked
Bun install includes Playwright; install its browser once with
`bunx playwright install chromium`. The isolated reader fixture runs by
default:

```sh
./ops/ui-test.sh
```

Live integration is deliberately opt-in. It requires an explicit public test
video and supports any authorized local or test route:

```sh
MEDIA_READER_BASE_URL=http://127.0.0.1:8099 \
MEDIA_READER_TEST_VIDEO_URL=https://www.youtube.com/watch?v=public-test-id \
MEDIA_READER_RUN_INTEGRATION_UI=1 \
./ops/ui-test.sh
```

Do not use private user media, cookies, credentials, transcripts, or production
data for browser fixtures or release screenshots.

### Evaluation and regeneration scripts

Prompt evaluation never selects personal defaults. Supply the video IDs,
provider, and user-chosen model explicitly:

```sh
bun scripts/eval-article-prompts.mjs \
  --videos video-id-1,video-id-2 \
  --provider openrouter \
  --model provider/model-id
```

Evaluation reads stored transcripts and writes private evaluation artifacts
under the configured data directory. Do not publish them without explicit
content clearance.

Article regeneration defaults to a dry run. Review the selected count and IDs,
then pass `--write` only when the intended runtime database is backed up and
the write is authorized:

```sh
bun scripts/regenerate-articles.mjs --limit 10
bun scripts/regenerate-articles.mjs --limit 10 --write
```

## Reverse proxy

Media Reader listens on `PORT` (default `8099`). The frontend derives its base
path from the loaded script URL, so a reverse proxy may publish the app under a
path prefix as long as it consistently strips that prefix before forwarding API
requests. Configure authentication, TLS, hostnames, and private networks in your
deployment layer, not in the public app source.

The owner's future `app`/`private`/`runtime` workspace migration is documented
in [docs/workspace-migration.md](docs/workspace-migration.md). That runbook does
not authorize or perform a live move.

## Project policies and release status

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Verified public-release audit](docs/public-release-audit.md)
- [Owner-gated public-release checklist](docs/public-release-checklist.md)

The repository remains private at the documented checkpoint. The audit
recommends a clean public snapshot while retaining the private development
repository and history, but the history/visibility choice belongs to the
owner. None of these documents authorizes a visibility change, new repository,
history rewrite, push, live migration, adapter removal, or deletion.
