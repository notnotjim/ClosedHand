# Built-in voice

ClosedHand includes an English Kokoro v1.0 voice. Use the speaker beside a web-chat
reply to read it aloud, and the same control to stop. In WhatsApp or Telegram, say
"voice replies on" to receive spoken replies to voice notes, or "voice replies off"
for text. Chat apps fall back to text when speech fails or the reply is too long.

Speech output runs on the computer hosting ClosedHand, without a provider account,
key or usage fee. Incoming voice notes still use the existing hosted transcription
service before their text reaches the primary LLM. This feature does not make
incoming voice transcription local.

## Packaging and verification

Mac and Docker builds run `node scripts/prepare-voice.js`. It downloads the pinned
files in `lib/speech/assets.json`, verifies their size and SHA-256, and bundles them
with the release. Source installations need to run that command once after
`npm ci`. The model and voice files total about 93 MB before packaging; runtime
speech never downloads files. See NOTICE for attribution and licences.

The existing ONNX runtime is reused. A single worker loads on demand, serialises
requests with a bounded queue, and unloads after a minute of inactivity. Browser
audio streams sentence by sentence; chat apps receive an Ogg Opus voice note.
The first reply takes longer while the model loads. Speed and memory use depend
on the host and other running tasks. Stopping web playback or closing its socket
cancels its generation, without broadcasting audio to other sessions.

Run `node --test scripts/test-speech.js` for protocol, cancellation, recovery,
asset-integrity and codec tests. `node scripts/bench-speech.js <output-directory>`
exercises the actual bundled model, saves synthetic WAV/Opus samples and reports
latency and process memory. Run it with network disabled to verify offline output.
