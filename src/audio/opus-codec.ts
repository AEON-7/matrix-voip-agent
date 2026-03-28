import { OpusEncoder } from "@discordjs/opus";

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 1920 (16-bit PCM)

// @discordjs/opus uses OpusEncoder for both encode and decode
export function createCodec(): OpusEncoder {
  return new OpusEncoder(SAMPLE_RATE, CHANNELS);
}

export function encodePcmToOpus(codec: OpusEncoder, pcm: Buffer): Buffer {
  return codec.encode(pcm);
}

export function decodeOpusToPcm(codec: OpusEncoder, opus: Buffer): Buffer {
  return codec.decode(opus);
}

export function silentFrame(): Buffer {
  return Buffer.alloc(FRAME_BYTES, 0);
}
