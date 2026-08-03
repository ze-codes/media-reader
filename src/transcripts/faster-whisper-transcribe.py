#!/usr/bin/env python3
import argparse
import json
import sys

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--wav", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--task", choices=["transcribe", "translate"], default="transcribe")
    parser.add_argument("--vad-filter", action="store_true")
    args = parser.parse_args()

    language = None if args.language == "auto" else args.language
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.threads,
        num_workers=args.workers,
        download_root=args.model_dir,
    )
    segments, info = model.transcribe(
        args.wav,
        language=language,
        task=args.task,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
        condition_on_previous_text=False,
    )
    transcript_segments = []
    text_parts = []
    for segment in segments:
        text_parts.append(segment.text)
        transcript_segments.append(
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
            }
        )
    text = "".join(text_parts).strip()
    json.dump(
        {
            "text": text,
            "segments": transcript_segments,
            "language": info.language,
            "language_probability": info.language_probability,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
