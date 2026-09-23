# Speech-to-text selection

Which speech-to-text Waldo uses for owner voice notes, and why. Research pass on 23 September 2026. Prices and claims come from the sources linked below and were checked that day. None of them are our own benchmarks yet.

## What Waldo needs

- Pre-recorded voice notes, usually 5 to 60 seconds, sent through Telegram as OGG/Opus.
- Hindi-English code-switching. The owner is in India, so a single pinned language would break mixed speech.
- Low cost per note, good accuracy on short and noisy clips, and a plain HTTPS API that works from a Cloudflare Worker.
- No streaming for now. Voice notes arrive complete.

## Options

| Provider / model | Batch price | Notes |
|---|---|---|
| ElevenLabs Scribe v2 | $0.22 per audio hour, keyterm prompting +$0.05/h | Best independent multilingual accuracy among hosted APIs (93.5% on FLEURS across 30 languages). 90+ languages with detection. Takes all major audio formats. Keyterm prompting could teach it Waldo words and names. |
| Deepgram Nova-3 | about $0.0043/min (about $0.26/h) | Fastest, strong in English batch. Trails ElevenLabs and AssemblyAI on independent real-world WER. |
| AssemblyAI Universal-3 Pro / 3.5 Pro | see vendor | Lowest streaming WER in one independent ranking. Strongest English transcript features. |
| OpenAI gpt-4o-mini-transcribe / gpt-transcribe | $0.003/min (mini) | Cheapest managed option. Our current OpenAI project has no access to any transcription model. The docs list no ogg input. |
| smallest.ai Pulse | owner has free credits | Pre-recorded endpoint takes OGG/Opus raw bytes. Supports `en` and `hi` but has no Hindi-English auto-detect aggregator on batch, so we pin `en`. |
| Groq whisper-large-v3-turbo | about $0.04/h | Cheapest overall. Whisper no longer leads any independent accuracy benchmark. |
| Wispr Flow API (Canto model) | not verified | Canto (17 Sep 2026) had the lowest WER on Wispr's own dictation set. The API rewrites what people say (auto-edits, filler removal). Useful for dictation, but less right for an agent that should hear the owner's own words. Access terms not checked. |
| OpenWhispr | - | A dictation app, not a model. It offers local Whisper/Parakeet and cloud keys (OpenAI, Groq, Mistral, smallest.ai). |

## Verdict

- Recommended default: ElevenLabs Scribe v2. It's the most accurate option for mixed Hindi-English, cheap at voice-note lengths (about $0.004 for a 60-second note), and needs no format conversion.
- Configured options: smallest.ai Pulse (the owner's free credits, English pinned) and OpenAI transcription (once the project has model access).
- Next step once a key lands: run 10 real owner voice notes, English and Hinglish, through each configured provider, and compare transcripts and latency before we lock it in.
- Later: keyterm prompting with Waldo vocabulary and contact names, and streaming if the app adds live voice.

## How it is wired

- `packages/runtime/src/llm/transcriber.ts` picks the first provider with a key, in the order ElevenLabs, smallest.ai, OpenAI. `WALDO_STT_PROVIDER` pins one.
- Secrets: `ELEVENLABS_API_KEY`, `SMALLEST_AI_API_KEY`, `OPENAI_API_KEY` as Worker secrets.
- Model ids live in `packages/contracts/src/model/roster.ts`.
- The transcript goes into the conversation as `[Owner sent a voice note. Transcript: ...]`. Audio is never stored or sent to the chat model.

## Sources

- ElevenLabs STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- Independent ranking, 1 Aug 2026: https://topaitracker.com/rankings/2026-08-01-best-ai-speech-to-text-apis-for-developers-ranked-by-accuracy-latency-and-cost/
- Coval benchmark overview: https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/
- Open ASR Leaderboard: https://huggingface.co/spaces/hf-audio/open_asr_leaderboard
- smallest.ai Pulse quickstart: https://docs.smallest.ai/models/documentation/speech-to-text-pulse/pre-recorded/quickstart.md
- smallest.ai audio formats: https://docs.smallest.ai/models/documentation/speech-to-text-pulse/pre-recorded/audio-formats.md
- OpenAI speech-to-text: https://developers.openai.com/api/docs/guides/speech-to-text
- Wispr Canto: https://wisprflow.ai/canto
- Wispr Flow API: https://wisprflow.mintlify.app/introduction
- OpenWhispr modes: https://mintlify.wiki/OpenWhispr/openwhispr/features/transcription-modes
- Groq Whisper turbo: https://console.groq.com/docs/model/whisper-large-v3-turbo
