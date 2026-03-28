import Opusscript = require('opusscript');

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 1920 (16-bit PCM)

export class OpusEncoder {
  private encoder: Opusscript;

  constructor(sampleRate: number, channels: number) {
    this.encoder = new Opusscript(sampleRate as any, channels);
  }

  encode(pcm: Buffer): Buffer {
    const encoded = this.encoder.encode(pcm, FRAME_SAMPLES);
    return Buffer.from(encoded);
  }

  decode(opusData: Buffer): Buffer {
    const decoded = this.encoder.decode(opusData);
    return Buffer.from(decoded);
  }
}

// @opusscript uses OpusEncoder for both encode and decode
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
