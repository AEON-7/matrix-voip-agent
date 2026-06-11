import { VoiceTool, VoiceToolRichResult } from "./types.js";
import type { VideoFrameSource } from "../video/frame-sampler.js";

/** Encode a JPEG buffer as an OpenAI image_url data URL. */
export function jpegDataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Camera "look" tool — instance-bound per call. The voice pipeline registers
 * it only when the active call has a live video track, so voice-only calls
 * see the exact same tool list as before.
 */
export function makeLookTool(source: VideoFrameSource): VoiceTool {
  return {
    name: "look",
    description:
      "Look through the caller's camera. Returns the most recent camera frame(s) as images. " +
      "Use this when the caller asks what you can see, shows you something, or when seeing " +
      "the camera would help answer.",
    parameters: {
      frames: {
        type: "integer",
        description: "How many frames to return, 1 to 4. Use 1 unless motion context is needed.",
      },
      spread_seconds: {
        type: "number",
        description:
          "0 for the freshest frame(s) only. If greater than 0, frames are spread over the last N seconds.",
      },
    },
    fillerPhrase: "Let me take a look.",
    async execute(args): Promise<VoiceToolRichResult> {
      const count = clampInt(args.frames, 1, 4, 1);
      const spread = Math.max(0, Number(args.spread_seconds) || 0);

      if (!source.isActive()) {
        return { text: "No camera feed available — this call has no video." };
      }

      const frames = source.getFrames(count, spread);
      if (frames.length === 0) {
        return {
          text: "The camera is connected but no frame has been decoded yet. Try again in a couple of seconds.",
        };
      }

      const now = Date.now();
      const ages = frames
        .map((f) => `${((now - f.ts) / 1000).toFixed(1)}s ago`)
        .join(", ");
      return {
        text: `Returning ${frames.length} camera frame(s), captured: ${ages}.`,
        images: frames.map((f) => f.jpeg),
      };
    },
  };
}
