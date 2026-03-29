# Agent Integration Guide

This file is for AI agents (OpenClaw, Claude Code, etc.) that need to integrate with or control the matrix-voip-agent voice call system. Read this file to understand the system's capabilities, APIs, and how to interact with it.

---

## What This System Does

This is a headless voice call agent for Matrix. It answers incoming VoIP calls and can initiate outbound calls. During a call, it:

1. Listens to the caller via WebRTC
2. Transcribes speech locally using whisper.cpp
3. Sends the transcript to an LLM (via OpenAI-compatible API)
4. Speaks the LLM response back using ElevenLabs TTS
5. Saves a full transcript when the call ends

The voice pipeline bypasses Matrix for the conversation loop — Matrix is only used for call signaling (ringing, answering, hanging up).

---

## How to Make the Agent Call Someone

Send an HTTP POST to the voice agent's API:

```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!roomid:homeserver",
    "userId": "@user:homeserver",
    "greeting": "Hey, I wanted to let you know your build finished successfully."
  }'
```

**Parameters:**
- `roomId` (required): The Matrix room ID where the call will be placed. Must be a DM room with the target user.
- `userId` (required): The Matrix user ID to call.
- `greeting` (optional): What the agent says when the call connects. If omitted, defaults to a generic greeting.

**Response:**
```json
{"callId": "outbound-1234567890-abc123", "status": "invite_sent"}
```

The target user's Matrix client (Element) will ring. When they answer, the voice conversation begins.

---

## How to End a Call

```bash
curl -X POST http://127.0.0.1:8179/hangup \
  -H "Authorization: Bearer API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callId": "outbound-1234567890-abc123"}'
```

---

## How to Check Active Calls

```bash
curl http://127.0.0.1:8179/status \
  -H "Authorization: Bearer API_TOKEN"
```

Response: `{"activeCalls": 0}`

---

## API Details

| Endpoint | Method | Auth | Body | Description |
|---|---|---|---|---|
| `/call` | POST | Bearer token | `{roomId, userId, greeting?}` | Initiate outbound call |
| `/hangup` | POST | Bearer token | `{callId}` | End a call |
| `/status` | GET | Bearer token | — | Active call count |

- **Base URL**: `http://127.0.0.1:8179` (configurable via `API_PORT` env var)
- **Auth**: `Authorization: Bearer <API_TOKEN>` header (token from `.env`)

---

## Voice Tools Available During Calls

When the agent is on a call, the LLM has these tools available:

| Tool | Description | Use when |
|---|---|---|
| `get_current_time` | Returns current date and time | Caller asks about the time or date |
| `check_server_status` | Checks if the vLLM server is healthy | Caller asks about server or infrastructure status |
| `run_command` | Runs a shell command and returns output | Caller asks about system info (disk, uptime, processes) |
| `web_search` | Searches the web via Brave Search | Caller asks about news, weather, facts, current events |
| `send_message` | Sends a text message to the Matrix room | Caller asks to post something in the chat |

Tools execute in the background while the agent speaks a filler phrase (e.g., "Let me check on that."). The tool result is then used to generate the spoken response.

---

## Call Transcripts

After every call, transcripts are saved to:

- `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.md` — Human-readable markdown
- `~/matrix-voip-agent/transcripts/call-YYYY-MM-DD_HH-MM-SS.json` — Machine-readable JSON

### JSON transcript format:
```json
{
  "callStart": "2026-03-29T07:00:00.000Z",
  "caller": "@albert:matrix.unhash.me",
  "sttMode": "whisper",
  "transcript": [
    {"timestamp": "2026-03-29T07:00:05.000Z", "speaker": "user", "text": "Hey Celina, what time is it?"},
    {"timestamp": "2026-03-29T07:00:12.000Z", "speaker": "celina", "text": "It's 3 AM on Saturday, March 29th."}
  ]
}
```

---

## Service Management

The voice agent runs as a systemd user service:

```bash
# Check status
systemctl --user status matrix-voip-agent.service

# View live logs
journalctl --user -u matrix-voip-agent.service -f

# Restart
systemctl --user restart matrix-voip-agent.service

# Stop
systemctl --user stop matrix-voip-agent.service
```

---

## Key File Locations

| File | Purpose |
|---|---|
| `~/matrix-voip-agent/.env` | All configuration (credentials, endpoints, settings) |
| `~/matrix-voip-agent/transcripts/` | Call transcripts (markdown + JSON) |
| `~/matrix-voip-agent/src/tools/built-in.ts` | Voice tool definitions (add new tools here) |
| `~/matrix-voip-agent/src/llm/vllm-client.ts` | LLM client and system prompt |
| `~/matrix-voip-agent/src/voice-pipeline.ts` | Main voice pipeline orchestration |
| `~/.config/pipewire/pipewire.conf.d/` | PipeWire virtual audio device configs |
| `~/whisper.cpp/models/` | Whisper STT models |

---

## How to Add a New Voice Tool

Add a new tool in `src/tools/built-in.ts`:

```typescript
const myNewTool: VoiceTool = {
  name: "my_tool_name",
  description: "What this tool does (shown to the LLM)",
  parameters: {
    someParam: { type: "string", description: "Parameter description" },
  },
  fillerPhrase: "Working on that now.",
  async execute(args) {
    // Do something with args.someParam
    return "Result text that the LLM will use to formulate a spoken response";
  },
};
```

Then add it to the `BUILT_IN_TOOLS` array at the bottom of the file. Rebuild with `npm run build` and restart the service.

---

## System Prompt

The LLM uses a voice-optimized system prompt during calls. Key behaviors:

- Responses are short (1-3 sentences) since they'll be spoken aloud
- No markdown, bullet points, or formatting
- Natural conversational tone with contractions
- Uses tools when real-time information is needed
- Does NOT announce tool calls — the system handles filler phrases automatically

The system prompt can be customized via `VLLM_SYSTEM_PROMPT` in `.env`, or by editing `VOICE_SYSTEM_PROMPT` in `src/llm/vllm-client.ts`.

---

## Network Architecture

```
Voice agent (this machine):
  :8008  ← Matrix homeserver (Dendrite, localhost)
  :8178  ← whisper-server (auto-started per call, localhost)
  :8179  ← Voice agent API (outbound calls, localhost)
  :3478  ← coturn TURN server (LAN/public)

Remote:
  vLLM server   → LLM inference (OpenAI-compatible API)
  ElevenLabs    → Text-to-speech (cloud API)
  Brave Search  → Web search (cloud API, optional)
```

---

## Common Integration Patterns

### Notify the user about something urgent
```bash
curl -X POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roomId": "'$ROOM_ID'", "userId": "'$USER_ID'", "greeting": "Alert: the disk is 95 percent full on the production server."}'
```

### Schedule a check-in call
```bash
# Using cron or a scheduler
echo "0 9 * * 1-5 curl -sX POST http://127.0.0.1:8179/call -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{\"roomId\":\"!room:server\",\"userId\":\"@user:server\",\"greeting\":\"Good morning! Here is your daily briefing.\"}'" | crontab -
```

### Call after a long-running task completes
```bash
# At the end of a build script, deployment, etc.
./deploy.sh && curl -sX POST http://127.0.0.1:8179/call \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roomId": "'$ROOM_ID'", "userId": "'$USER_ID'", "greeting": "Your deployment just finished. Everything looks good."}'
```

### Read the latest transcript programmatically
```bash
# Get the most recent call transcript
cat ~/matrix-voip-agent/transcripts/$(ls -t ~/matrix-voip-agent/transcripts/*.json | head -1)
```
