import { createServer } from "http";
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

  // HTTP API for triggering outbound calls
  const apiPort = parseInt(process.env.API_PORT || "8179", 10);
  const apiToken = process.env.API_TOKEN || "";

  const server = createServer(async (req, res) => {
    // Auth check
    if (apiToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${apiToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // POST /call — initiate outbound call
    if (req.method === "POST" && req.url === "/call") {
      try {
        const body = await readBody(req);
        const { roomId, userId, greeting } = JSON.parse(body);

        if (!roomId || !userId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "roomId and userId required" }));
          return;
        }

        const callId = await callManager.initiateCall(
          client,
          roomId,
          userId,
          greeting || "Hey, I'm calling to check in."
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ callId, status: "invite_sent" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /hangup — end a call
    if (req.method === "POST" && req.url === "/hangup") {
      try {
        const body = await readBody(req);
        const { callId } = JSON.parse(body);
        callManager.handleRemoteHangup(callId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /status — active calls
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activeCalls: callManager.activeCallCount }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(apiPort, "127.0.0.1", () => {
    logger.info(TAG, `API server listening on http://127.0.0.1:${apiPort}`);
  });

  logger.info(TAG, "Matrix VoIP Agent ready — waiting for calls");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(TAG, "Shutting down...");
    server.close();
    callManager.shutdown();
    client.stopClient();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
