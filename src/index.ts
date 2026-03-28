import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { createMatrixClient } from "./matrix/client.js";
import { registerCallHandlers } from "./matrix/call-signaling.js";
import { CallManager } from "./call-manager.js";

const TAG = "main";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info(TAG, "Matrix VoIP Agent starting...");
  logger.info(TAG, `User: ${config.matrix.userId}`);
  logger.info(TAG, `Homeserver: ${config.matrix.homeserverUrl}`);
  logger.info(TAG, `Authorized callers: ${config.authorizedUsers.join(", ") || "(any)"}`);
  logger.info(TAG, `Max concurrent calls: ${config.calls.maxConcurrent}`);
  logger.info(TAG, `PipeWire STT sink: ${config.pipewire.sttSink}`);
  logger.info(TAG, `PipeWire TTS source: ${config.pipewire.ttsSource}`);

  // Connect to Matrix
  const client = await createMatrixClient(config);

  // Initialize call manager with TURN credentials
  const callManager = new CallManager(config);
  await callManager.init(client);

  // Register VoIP event handlers
  registerCallHandlers(client, config, callManager);

  logger.info(TAG, "Matrix VoIP Agent ready — waiting for calls");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(TAG, "Shutting down...");
    callManager.shutdown();
    client.stopClient();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
