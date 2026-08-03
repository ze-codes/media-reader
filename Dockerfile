FROM oven/bun:slim

# System deps:
#  - python3 + pip for yt-dlp + bgutil-pot-provider plugin
#  - ffmpeg for audio extraction (used by yt-dlp and transcription backends)
#  - build-essential + cmake + git for building whisper.cpp
#  - curl + ca-certificates for model + deno downloads
#  - unzip needed by deno installer
# yt-dlp plugins:
#  - bgutil-ytdlp-pot-provider: queries the bgutil-pot-provider sidecar to
#    mint ProofOfOrigin tokens; needed for "Sign in to confirm you're not
#    a bot" videos.
# Deno is installed to /usr/local/bin so yt-dlp finds it on PATH for
# n-parameter and player JS challenge solving.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip \
        ffmpeg \
        build-essential cmake git \
        curl ca-certificates unzip && \
    pip3 install --break-system-packages --no-cache-dir \
        yt-dlp bgutil-ytdlp-pot-provider faster-whisper && \
    curl -fsSL https://deno.land/install.sh | sh -s -- -y && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    rm -rf /root/.deno /var/lib/apt/lists/*

# Build whisper.cpp (CPU, no GPU deps). Build statically (BUILD_SHARED_LIBS=OFF)
# so the whisper-cli binary is self-contained. Build only the whisper-cli
# target to avoid the deprecation-warning shims in other example targets.
RUN git clone --depth 1 --branch v1.7.4 https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp && \
    cmake -S /opt/whisper.cpp -B /opt/whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON && \
    cmake --build /opt/whisper.cpp/build --config Release -j$(nproc) --target whisper-cli && \
    cp /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli && \
    /usr/local/bin/whisper-cli --help > /dev/null 2>&1 || \
        (echo "whisper-cli failed smoke test"; /usr/local/bin/whisper-cli 2>&1 | head; exit 1) && \
    rm -rf /opt/whisper.cpp

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

CMD ["bun", "src/main.mjs"]
