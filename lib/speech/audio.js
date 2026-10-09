const crypto = require("crypto");

function wav(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24000, 24); out.writeUInt32LE(48000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}

// Ogg pages carry a single Opus packet. Granule positions are always at 48kHz,
// even though Kokoro and the encoder receive 24kHz mono PCM (RFC 7845).
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  return crc >>> 0;
});
function page(packet, serial, sequence, granule, flags) {
  const segments = Math.floor(packet.length / 255) + 1;
  const out = Buffer.alloc(27 + segments + packet.length);
  out.write("OggS"); out[5] = flags;
  out.writeBigUInt64LE(BigInt(granule), 6);
  out.writeUInt32LE(serial, 14); out.writeUInt32LE(sequence, 18); out[26] = segments;
  for (let i = 0; i < segments; i++) out[27 + i] = Math.min(255, packet.length - i * 255);
  packet.copy(out, 27 + segments);
  let crc = 0;
  for (const byte of out) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
  out.writeUInt32LE(crc, 22);
  return out;
}
function oggOpus(samples) {
  const Opus = require("opusscript");
  const encoder = new Opus(24000, 1, Opus.Application.AUDIO);
  const serial = crypto.randomBytes(4).readUInt32LE();
  const head = Buffer.alloc(19);
  head.write("OpusHead"); head[8] = 1; head[9] = 1;
  head.writeUInt16LE(312, 10); head.writeUInt32LE(24000, 12);
  const vendor = Buffer.from("Closedhand");
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write("OpusTags"); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12);
  const pages = [page(head, serial, 0, 0, 2), page(tags, serial, 1, 0, 0)];
  const frame = Buffer.alloc(960);
  const frames = Math.ceil((samples.length + 156) / 480);
  try {
    encoder.encoderCTL(4002, 24000);
    for (let i = 0; i < frames; i++) {
      frame.fill(0);
      for (let j = 0; j < 480 && i * 480 + j < samples.length; j++) {
        frame.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i * 480 + j])) * 32767), j * 2);
      }
      const last = i === frames - 1;
      const granule = last ? samples.length * 2 + 312 : (i + 1) * 960;
      pages.push(page(encoder.encode(frame, 480), serial, i + 2, granule, last ? 4 : 0));
    }
    return Buffer.concat(pages);
  } finally { encoder.delete(); }
}
// Reading voice notes back: an Ogg Opus file (WhatsApp's and Telegram's) as
// 16 kHz mono samples for speech to text (lib/services/listen.js).
function oggPackets(buffer) {
  const packets = [];
  let pending = [], i = 0;
  while (i + 27 <= buffer.length) {
    if (buffer.toString("ascii", i, i + 4) !== "OggS") throw new Error("Not an Ogg file");
    const segments = buffer[i + 26];
    let at = i + 27 + segments;
    for (const length of buffer.subarray(i + 27, i + 27 + segments)) {
      pending.push(buffer.subarray(at, at + length)); at += length;
      if (length < 255) { packets.push(Buffer.concat(pending)); pending = []; }
    }
    i = at;
  }
  return packets;
}
function oggOpusSamples(buffer) {
  const packets = oggPackets(buffer);
  if (!packets[0] || packets[0].toString("ascii", 0, 8) !== "OpusHead") throw new Error("Not an Opus voice note");
  const channels = packets[0][9] || 1, preSkip = packets[0].readUInt16LE(10);
  const Opus = require("opusscript");
  const decoder = new Opus(48000, channels, Opus.Application.AUDIO);
  const parts = [];
  let total = 0;
  try {
    for (const packet of packets.slice(2)) {
      const pcm = decoder.decode(packet);
      const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const mono = new Float32Array(Math.floor(view.length / channels));
      for (let s = 0; s < mono.length; s++) { let sum = 0; for (let c = 0; c < channels; c++) sum += view[s * channels + c]; mono[s] = sum / channels / 32768; }
      parts.push(mono); total += mono.length;
    }
  } finally { decoder.delete(); }
  const all = new Float32Array(total);
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  // 48 kHz to 16 kHz: the average of each three samples, after Opus's pre-skip.
  const start = Math.min(preSkip, all.length);
  const out = new Float32Array(Math.floor((all.length - start) / 3));
  for (let k = 0; k < out.length; k++) { const j = start + k * 3; out[k] = (all[j] + all[j + 1] + all[j + 2]) / 3; }
  return out;
}
module.exports = { wav, oggOpus, oggOpusSamples };
