#!/usr/bin/env node
/**
 * Smoke test for the video frame sampler's ffmpeg spawn + JPEG parse path.
 * No real call needed:
 *
 *   Stage A: ffmpeg lavfi testsrc -> libvpx VP8 -> IVF (in memory)
 *   Stage B: demux that IVF, RE-MUX it with the sampler's own ivfFileHeader/
 *            ivfFrameHeader, feed it into ffmpeg spawned with the sampler's
 *            exact input/filter/output args, and split stdout with the
 *            sampler's JpegStreamParser.
 *
 * Asserts >= 2 frames parsed, each starting with JPEG magic FFD8FF.
 */
import { spawn } from "child_process";
import {
  JpegStreamParser,
  ffmpegSampleArgs,
  ivfFileHeader,
  ivfFrameHeader,
} from "../dist/video/frame-sampler.js";

const FPS = 1;
const WIDTH = 512;

function run(args, stdinBuf) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
    if (stdinBuf) proc.stdin.end(stdinBuf);
    else proc.stdin.end();
  });
}

// Stage A: synthetic VP8 IVF stream
const ivf = await run([
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=5",
  "-c:v", "libvpx", "-f", "ivf", "pipe:1",
]);
console.log(`Stage A: encoded synthetic IVF VP8 stream (${ivf.length} bytes)`);

// Demux: 32-byte file header, then 12-byte frame headers (size LE32 + pts LE64)
const frames = [];
let off = 32;
while (off + 12 <= ivf.length) {
  const size = ivf.readUInt32LE(off);
  const pts = Number(ivf.readBigUInt64LE(off + 4));
  off += 12;
  if (off + size > ivf.length) break;
  frames.push({ data: ivf.subarray(off, off + size), pts });
  off += size;
}
if (frames.length < 5) {
  console.error(`FAIL: expected >=5 VP8 frames from testsrc, got ${frames.length}`);
  process.exit(1);
}
console.log(`Demuxed ${frames.length} VP8 frames`);

// Re-mux through the sampler's own IVF writers (pts in ms: 5 fps -> 200ms steps)
const remuxed = Buffer.concat([
  ivfFileHeader(),
  ...frames.flatMap((f, i) => [ivfFrameHeader(f.data.length, i * 200), f.data]),
]);

// Stage B: the sampler's exact ffmpeg invocation
const samplerArgs = [
  "-hide_banner", "-loglevel", "error",
  "-f", "ivf", "-i", "pipe:0",
  ...ffmpegSampleArgs(FPS, WIDTH),
];
console.log(`Stage B: ffmpeg ${samplerArgs.join(" ")}`);
const mjpegStream = await run(samplerArgs, remuxed);

// Split with the sampler's own parser, chunked to exercise buffering
const parser = new JpegStreamParser();
const jpegs = [];
for (let i = 0; i < mjpegStream.length; i += 4096) {
  parser.push(mjpegStream.subarray(i, i + 4096), (jpeg) => jpegs.push(jpeg));
}

let ok = true;
for (const [i, jpeg] of jpegs.entries()) {
  const magic = jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff;
  const eoi = jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
  console.log(`  frame ${i}: ${jpeg.length} bytes, SOI+magic=${magic}, EOI=${eoi}`);
  if (!magic || !eoi) ok = false;
}

if (jpegs.length >= 2 && ok) {
  console.log(`PASS: ${jpegs.length} JPEG frames parsed with valid magic`);
  process.exit(0);
} else {
  console.error(`FAIL: ${jpegs.length} frames parsed, magicOk=${ok}`);
  process.exit(1);
}
