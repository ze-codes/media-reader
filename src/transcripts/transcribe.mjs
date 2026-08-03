// Audio transcription wrapper. The primary backend is faster-whisper
// (CTranslate2), with whisper.cpp kept as a local fallback.

import { spawn } from 'child_process';
import { readFileSync, existsSync, statSync, mkdirSync, createWriteStream, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpus } from 'os';
import https from 'https';
import { log } from '../shared/log.mjs';
import { dataDir } from '../shared/paths.mjs';
import { buildTranscriptResult } from './segments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.YT_TRANSCRIBE_BACKEND || 'faster-whisper';
const PYTHON = process.env.YT_FAST_WHISPER_PYTHON || 'python3';

const FASTER_MODEL_DIR = process.env.YT_FAST_WHISPER_MODEL_DIR || join(dataDir(), 'faster-whisper');
const FASTER_MODEL = process.env.YT_FAST_WHISPER_MODEL || 'large-v3-turbo';
const FASTER_DEVICE = process.env.YT_FAST_WHISPER_DEVICE || 'cpu';
const FASTER_COMPUTE_TYPE = process.env.YT_FAST_WHISPER_COMPUTE_TYPE || 'int8';
const FASTER_BEAM_SIZE = Number(process.env.YT_FAST_WHISPER_BEAM_SIZE || 5);
const FASTER_LANGUAGE = process.env.YT_FAST_WHISPER_LANGUAGE || process.env.YT_WHISPER_LANGUAGE || 'auto';
const FASTER_TASK = process.env.YT_FAST_WHISPER_TASK || 'transcribe';
const FASTER_VAD_FILTER = parseFastWhisperVadFilter(process.env.YT_FAST_WHISPER_VAD_FILTER);

const GGML_MODEL_DIR = join(dataDir(), 'models');
// whisper.cpp model — can be overridden with YT_WHISPER_MODEL env var.
// Use multilingual small by default: English-only models emit placeholder text
// for non-English videos, which can look like a successful transcript.
const GGML_MODEL_FILE = process.env.YT_WHISPER_MODEL || 'ggml-small.bin';
const GGML_MODEL_PATH = join(GGML_MODEL_DIR, GGML_MODEL_FILE);
const WHISPER_LANGUAGE = process.env.YT_WHISPER_LANGUAGE || 'auto';
const WHISPER_TRANSLATE = process.env.YT_WHISPER_TRANSLATE === '1';
let fasterWhisperAvailability;

export function modelAvailable() {
    if (BACKEND === 'faster-whisper') return true;
    return existsSync(GGML_MODEL_PATH) && statSync(GGML_MODEL_PATH).size > 1_000_000;
}

export function transcribeBackend() {
    return BACKEND;
}

export function parseFastWhisperVadFilter(value) {
    return value !== '0';
}

function withoutSource(result) {
    return { text: result.text, segments: result.segments };
}

export function parseFasterWhisperOutput(payload) {
    let parsed = payload;
    if (typeof payload === 'string') {
        try { parsed = JSON.parse(payload); } catch { parsed = {}; }
    }
    const segments = Array.isArray(parsed?.segments)
        ? parsed.segments.map(segment => ({
            startMs: typeof segment?.start === 'number' ? segment.start * 1000 : Number.NaN,
            endMs: typeof segment?.end === 'number' ? segment.end * 1000 : Number.NaN,
            text: segment?.text,
        }))
        : [];
    return withoutSource(buildTranscriptResult({
        text: parsed?.text,
        source: 'whisper',
        segments,
    }));
}

export function parseWhisperCppOutput(payload, fallbackText = '') {
    let parsed = payload;
    if (typeof payload === 'string') {
        try { parsed = JSON.parse(payload); } catch { parsed = {}; }
    }
    const transcription = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
    return withoutSource(buildTranscriptResult({
        text: parsed?.text || transcription.map(segment => segment?.text || '').join(' ') || fallbackText,
        source: 'whisper',
        segments: transcription.map(segment => ({
            startMs: segment?.offsets?.from,
            endMs: segment?.offsets?.to,
            text: segment?.text,
        })),
    }));
}

function isMissingFasterWhisperModule(message) {
    return /No module named ['"]faster_whisper['"]/i.test(String(message || ''));
}

function detectFasterWhisperInstalled() {
    if (!fasterWhisperAvailability) {
        fasterWhisperAvailability = new Promise(resolve => {
            const proc = spawn(PYTHON, ['-c', 'import faster_whisper'], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d; });
            proc.on('error', () => resolve(false));
            proc.on('close', code => resolve(code === 0 && !isMissingFasterWhisperModule(stderr)));
        });
    }
    return fasterWhisperAvailability;
}

// Lazy download of the ggml model on first run. Kept simple: follows redirects
// from the Hugging Face mirror and writes to GGML_MODEL_PATH.
export async function ensureModel() {
    if (BACKEND === 'faster-whisper') {
        if (!(await detectFasterWhisperInstalled())) {
            throw new Error('faster-whisper python package is missing; rebuild the media-reader image or use whisper.cpp');
        }
        mkdirSync(FASTER_MODEL_DIR, { recursive: true });
        return FASTER_MODEL_DIR;
    }
    if (modelAvailable()) return GGML_MODEL_PATH;
    return ensureWhisperCppModel();
}

export async function transcribeWav(wavPath) {
    if (BACKEND === 'faster-whisper') {
        try {
            return await transcribeWithFasterWhisper(wavPath);
        } catch (err) {
            if (!isMissingFasterWhisperModule(err?.message)) throw err;
            log('warn', 'transcribe', 'faster-whisper module missing in runtime; falling back to whisper.cpp');
            await ensureWhisperCppModel();
            return transcribeWithWhisperCpp(wavPath);
        }
    }
    return transcribeWithWhisperCpp(wavPath);
}

async function ensureWhisperCppModel() {
    if (existsSync(GGML_MODEL_PATH) && statSync(GGML_MODEL_PATH).size > 1_000_000) return GGML_MODEL_PATH;
    return downloadWhisperCppModel();
}

function downloadWhisperCppModel() {
    mkdirSync(GGML_MODEL_DIR, { recursive: true });
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${GGML_MODEL_FILE}`;
    const tmpPath = GGML_MODEL_PATH + '.part';

    return new Promise((resolve, reject) => {
        console.log(`[whisper.cpp] downloading ${GGML_MODEL_FILE}...`);
        const req = (u) => https.get(u, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                req(res.headers.location);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`model download failed: HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            const file = createWriteStream(tmpPath);
            res.pipe(file);
            file.on('finish', () => file.close(err => {
                if (err) return reject(err);
                try { renameSync(tmpPath, GGML_MODEL_PATH); }
                catch (e) { return reject(e); }
                console.log(`[whisper.cpp] model ready at ${GGML_MODEL_PATH}`);
                resolve(GGML_MODEL_PATH);
            }));
            file.on('error', reject);
        });
        req(url).on('error', reject);
    });
}

function transcribeWithFasterWhisper(wavPath) {
    return new Promise((resolve, reject) => {
        mkdirSync(FASTER_MODEL_DIR, { recursive: true });
        const args = [
            join(__dirname, 'faster-whisper-transcribe.py'),
            '--model', FASTER_MODEL,
            '--model-dir', FASTER_MODEL_DIR,
            '--wav', wavPath,
            '--device', FASTER_DEVICE,
            '--compute-type', FASTER_COMPUTE_TYPE,
            '--threads', String(Math.max(2, Math.min(8, cpus().length || 4))),
            '--workers', '1',
            '--beam-size', String(Number.isFinite(FASTER_BEAM_SIZE) ? FASTER_BEAM_SIZE : 5),
            '--language', FASTER_LANGUAGE,
            '--task', FASTER_TASK,
        ];
        if (FASTER_VAD_FILTER) args.push('--vad-filter');

        const proc = spawn(PYTHON, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`faster-whisper exited ${code}: ${stderr.trim().slice(0, 500)}`));
                return;
            }
            try {
                const result = parseFasterWhisperOutput(stdout);
                if (!result.text) reject(new Error('faster-whisper produced empty transcript'));
                else resolve(result);
            } catch (err) {
                reject(new Error(`could not parse faster-whisper output: ${err.message}; stderr=${stderr.trim().slice(0, 300)}`));
            }
        });
    });
}

function transcribeWithWhisperCpp(wavPath) {
    return new Promise((resolve, reject) => {
        if (!modelAvailable()) {
            reject(new Error(`whisper.cpp model missing at ${GGML_MODEL_PATH}`));
            return;
        }
        const outBase = wavPath.replace(/\.wav$/, '');
        const txtPath = outBase + '.txt';
        const jsonPath = outBase + '.json';

        const args = [
            '-m', GGML_MODEL_PATH,
            '-f', wavPath,
            '-oj',
            '-otxt',
            '-of', outBase,
            '-l', WHISPER_LANGUAGE,
            '-t', String(Math.max(2, Math.min(8, cpus().length || 4))),
        ];
        if (WHISPER_TRANSLATE) args.push('-tr');

        const proc = spawn('whisper-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(0, 500)}`));
                return;
            }
            try {
                let result = null;
                try {
                    result = parseWhisperCppOutput(readFileSync(jsonPath, 'utf8'));
                } catch {}
                if (!result?.text) {
                    result = {
                        text: readFileSync(txtPath, 'utf8').replace(/\s+/g, ' ').trim(),
                        segments: [],
                    };
                }
                if (!result.text) reject(new Error('whisper produced empty transcript'));
                else resolve(result);
            } catch (err) {
                reject(err);
            }
        });
    });
}
