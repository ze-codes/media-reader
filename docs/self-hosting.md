# Native self-hosting

Native installation is the recommended way to use Media Reader with Codex CLI or Claude Code CLI OAuth. The app launches the already-installed official CLI as the same operating-system user, so it does not need an API key or access to credential files. Containers remain a good fit for HTTP/API-key providers; using a host OAuth CLI from a container requires deliberately bridging the host executable and is not the default setup.

## Prerequisites

Install these commands on the host and make sure they are on the service user's `PATH`:

- Bun
- `yt-dlp`
- `ffmpeg`
- Python 3 plus `faster-whisper` (the default transcription backend), or `whisper-cli` for the `whisper.cpp` backend
- One generation provider: Codex CLI, Claude Code CLI, OpenRouter, or an OpenAI-compatible endpoint

On Linux, use your distribution package manager for Python and ffmpeg, then install `yt-dlp` and `faster-whisper` in an isolated Python environment if the distribution protects system Python. Set `YT_FAST_WHISPER_PYTHON` to that environment's Python executable. On macOS, a package manager can provide Python and ffmpeg; install Bun and the selected official provider CLI using their official instructions.

Clone or copy Media Reader, then install its JavaScript dependencies:

```sh
cd /absolute/path/to/media-reader
bun install --frozen-lockfile
cp .env.example .env
```

Verify the checkout before adding credentials or runtime data:

```sh
bun test
bun run smoke:public
```

The public smoke does not read `.env`, access data or cookies, start Docker, or
call external services.

Keep `.env` local and readable only by the account that runs Media Reader. At minimum, select a provider and model. For the native OAuth providers:

```sh
LLM_PROVIDER=codex-cli
LLM_MODEL=your-codex-model
```

or:

```sh
LLM_PROVIDER=claude-cli
LLM_MODEL=your-claude-model
```

Use `LLM_CODEX_BIN` or `LLM_CLAUDE_BIN` only when the selected official CLI is not discoverable on `PATH`. Use an absolute executable path for a background service. Do not put OAuth tokens or copied CLI credentials in `.env`.

## Provider login

Complete login directly through the official CLI as the same operating-system account that will run Media Reader:

```sh
codex login
```

or:

```sh
claude auth login
```

Media Reader checks authentication only with the official `codex login status` or `claude auth status` command. It never locates, reads, copies, mounts, or parses CLI credential files. Doctor output reduces either command to a generic authenticated/not-authenticated result; Claude identity fields such as email and organization IDs are discarded.

For an HTTP provider, configure `LLM_PROVIDER`, `LLM_MODEL`, and the provider endpoint/key variables described in `.env.example` instead. No native CLI login check is needed.

## Doctor and foreground start

Run the diagnostic before starting the app:

```sh
bun run doctor
bun run doctor -- --json
```

The doctor checks Bun, yt-dlp, ffmpeg, the selected Whisper backend, provider configuration, the selected provider binary and official login status when applicable, and writable database/cache/upload/model-data locations. Missing optional TranscriptAPI or cookies produce warnings. Only required failures result in a nonzero exit status. Environment values, provider status output, credential locations, and command errors are not included in human or JSON output.

Start Media Reader in the foreground:

```sh
bun run start
```

The default listener is port `8099`; set `PORT` when a different local port is required. Put an authentication-aware reverse proxy in front of the app before exposing it beyond a trusted host.

## Data paths

By default, persistent and generated files live below the repository's `data/` directory:

| Setting | Default | Purpose |
|---|---|---|
| `MEDIA_READER_DATA_DIR` | `./data` | Root for SQLite, cache, uploads, and model data |
| `MEDIA_READER_DB_PATH` | `$MEDIA_READER_DATA_DIR/media-reader.db` | SQLite database override |
| `YT_FAST_WHISPER_MODEL_DIR` | `$MEDIA_READER_DATA_DIR/faster-whisper` | faster-whisper model cache |
| — | `$MEDIA_READER_DATA_DIR/cache` | Temporary captions/audio and access state |
| — | `$MEDIA_READER_DATA_DIR/uploads` | Uploaded source media |
| — | `$MEDIA_READER_DATA_DIR/models` | whisper.cpp model data |

The runtime account must be able to create and write these locations. The doctor uses a unique temporary probe file and removes it immediately; it does not modify existing files. Back up the SQLite database and uploads that you need to retain. Cache and downloaded model data can be recreated.

## Optional TranscriptAPI and cookies

Set `TRANSCRIPT_API_KEY` to use TranscriptAPI as the first hosted YouTube transcript source. Its absence is a warning because captions and local Whisper remain available.

Cookies are also optional. Set `MEDIA_READER_COOKIE_DIR` to any directory of
Cookie-Editor JSON profiles readable by the native runtime account. Filenames
must begin with `youtube` or `xiaohongshu`. If the variable is unset, ingestion
falls back to `/cookies`. The directory does not need to be writable by the app.

Compose uses the same `MEDIA_READER_COOKIE_DIR` value as the host side of its
read-only bind (default `./cookies`) and mounts it at `/cookies`; the container
then uses the `/cookies` fallback. Do not place provider CLI credentials there.
If no usable cookie profile is available, the doctor warns and Media Reader
continues; some sites may block caption or audio access.

## Secondary Compose deployment

Compose is intended for OpenRouter or OpenAI-compatible HTTP providers. It is
not the default for Codex CLI or Claude Code CLI because the public container
does not mount host OAuth credential stores or private executables.

```sh
cp .env.example .env
# Configure an HTTP provider and model in .env.
docker compose up -d --build
```

The checked-in Compose deployment uses local persistent paths and does not
require an external proxy network. Keep `.env`, `data/`, and `cookies/` local.
If you attach the service to a private proxy network, do so in a private Compose
override or deployment layer without changing or mounting private source into
the public app.

## Linux systemd

The example unit at `deploy/media-reader.service.example` runs the normal foreground command under systemd. Adjust its install, executable, and account paths for the host. Create the runtime account and installation separately, then put settings in `/etc/media-reader/media-reader.env` with restrictive permissions. If an HTTP provider needs an API key, keep that file readable only by the service account.

Before enabling the unit:

1. Run the selected official provider login as the unit's `User`.
2. Run `bun run doctor` as that same user with the same environment file.
3. Confirm `/var/lib/media-reader` is writable by that user.
4. Install the reviewed unit, then use `systemctl enable --now media-reader`.

The service does not daemonize; systemd supervises `bun run start` directly. Logs go to the journal.

The example intentionally leaves the dedicated service user's home available because official OAuth CLIs manage their own login state there. Do not point the service at another user's home or copy credentials between accounts.

## macOS launchd

For a per-user service, create a LaunchAgent property list outside the repository. Use absolute paths in `ProgramArguments` for Bun and the project, set `WorkingDirectory` to the project directory, and provide only the required environment variables in `EnvironmentVariables`. The command arguments should be equivalent to:

```text
/absolute/path/to/bun run start
```

Set `MEDIA_READER_DATA_DIR` to an absolute writable directory and route standard output/error to files in a writable log directory. Run the provider login and doctor interactively from the same macOS account before loading the LaunchAgent. Do not embed credentials, a home-directory assumption, or user-specific paths in a shared template; generate the final plist locally and keep it out of version control.

## Troubleshooting

| Doctor result | What to check |
|---|---|
| Bun, yt-dlp, or ffmpeg unavailable | Run the command as the runtime account and fix that account's `PATH`. Background services often have a smaller `PATH` than an interactive shell. |
| Selected Whisper backend unavailable | For faster-whisper, verify `YT_FAST_WHISPER_PYTHON` runs `import faster_whisper`; for whisper.cpp, make `whisper-cli` available on `PATH`. |
| Provider configuration invalid | Check the selected provider's required model, endpoint, and key settings without printing the populated environment. |
| Provider binary unavailable | Use the official CLI installation and, if needed, an absolute `LLM_CODEX_BIN` or `LLM_CLAUDE_BIN`. |
| Provider CLI not authenticated | Run `codex login` or `claude auth login` as the exact account that starts Media Reader, then rerun doctor. |
| A data path is not writable | Fix ownership/permissions or choose an absolute `MEDIA_READER_DATA_DIR` and optional `MEDIA_READER_DB_PATH`. |
| TranscriptAPI warning | Set `TRANSCRIPT_API_KEY` if desired, or rely on captions and Whisper. |
| Cookie warning or site access failure | Point `MEDIA_READER_COOKIE_DIR` at readable optional profiles (or provide `/cookies`), refresh expired site cookies, and use the UI's reload action. |

Doctor deliberately reports generic command failures. Reproduce a failing non-auth dependency command directly as the runtime account for deeper diagnostics; do not paste provider status output or environment contents into logs or support tickets.
