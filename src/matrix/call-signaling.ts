import sdk from "matrix-js-sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { CallManager } from "../call-manager.js";

const TAG = "call-signaling";

export interface CallInvite {
  roomId: string;
  callId: string;
  partyId: string;
  version: string;
  offerSdp: string;
  sender: string;
  lifetime: number;
  invitee?: string;
  timestamp: number;
}

export function registerCallHandlers(
  client: sdk.MatrixClient,
  config: Config,
  callManager: CallManager
): void {
  client.on(sdk.RoomEvent.Timeline, (event, room) => {
    if (!room) return;

    const evType = event.getType();
    const sender = event.getSender();
    if (!sender || sender === config.matrix.userId) return;

    switch (evType) {
      case "m.call.invite":
        logger.info(TAG, `Received m.call.invite from ${sender} (age=${event.getLocalAge()}ms)`);
        handleInvite(client, config, callManager, event, room.roomId);
        break;
      case "m.call.candidates":
        handleCandidates(callManager, event);
        break;
      case "m.call.hangup":
        handleHangup(callManager, event);
        break;
      case "m.call.select_answer":
        handleSelectAnswer(config, callManager, event);
        break;
    }
  });

  logger.info(TAG, "Call signal handlers registered");
}

function handleInvite(
  client: sdk.MatrixClient,
  config: Config,
  callManager: CallManager,
  event: sdk.MatrixEvent,
  roomId: string
): void {
  const content = event.getContent();
  const sender = event.getSender()!;

  logger.info(TAG, `Call invite details: version=${JSON.stringify(content.version)}, call_id=${content.call_id}, has_offer=${!!content.offer?.sdp}`);

  if (content.version !== "1" && content.version !== 1 && content.version !== "0" && content.version !== 0) {
    logger.warn(TAG, `Ignoring call invite with version ${content.version}`);
    return;
  }

  // Check authorization
  if (
    config.authorizedUsers.length > 0 &&
    !config.authorizedUsers.includes(sender)
  ) {
    logger.warn(TAG, `Rejecting call from unauthorized user: ${sender}`);
    sendHangup(client, roomId, content.call_id, "user_busy");
    return;
  }

  // Check if invite has expired
  const age = event.getLocalAge() || 0;
  const lifetime = content.lifetime || 60000;
  if (age > lifetime) {
    logger.warn(TAG, `Ignoring expired call invite (age=${age}ms, lifetime=${lifetime}ms)`);
    return;
  }

  // Check invitee filter (multi-device)
  logger.info(TAG, `Invitee check: content.invitee=${JSON.stringify(content.invitee)}, our deviceName=${config.matrix.deviceName}`);
  if (content.invitee && content.invitee !== config.matrix.deviceName) {
    logger.warn(TAG, `Invite targeted at different device: ${content.invitee} (we are ${config.matrix.deviceName}), answering anyway`);
  }

  const invite: CallInvite = {
    roomId,
    callId: content.call_id,
    partyId: content.party_id,
    version: String(content.version),
    offerSdp: content.offer?.sdp || "",
    sender,
    lifetime,
    invitee: content.invitee,
    timestamp: Date.now(),
  };

  logger.info(TAG, `Incoming call from ${sender} (call_id=${invite.callId})`);
  callManager.handleInvite(client, invite);
}

function handleCandidates(
  callManager: CallManager,
  event: sdk.MatrixEvent
): void {
  const content = event.getContent();
  const callId = content.call_id;
  const candidates = content.candidates || [];

  if (candidates.length > 0) {
    logger.debug(TAG, `Received ${candidates.length} ICE candidates for ${callId}`);
    callManager.handleRemoteCandidates(callId, candidates);
  }
}

function handleHangup(callManager: CallManager, event: sdk.MatrixEvent): void {
  const content = event.getContent();
  const callId = content.call_id;
  const reason = content.reason || "unknown";

  logger.info(TAG, `Remote hangup for call ${callId}: ${reason}`);
  callManager.handleRemoteHangup(callId);
}

function handleSelectAnswer(
  config: Config,
  callManager: CallManager,
  event: sdk.MatrixEvent
): void {
  const content = event.getContent();
  const callId = content.call_id;
  const selectedPartyId = content.selected_party_id;

  // If the caller selected a different device's answer, we should hang up
  if (selectedPartyId && selectedPartyId !== config.matrix.deviceName) {
    logger.info(TAG, `Another device was selected for call ${callId}, hanging up`);
    callManager.handleRemoteHangup(callId);
  }
}

export async function sendAnswer(
  client: sdk.MatrixClient,
  roomId: string,
  callId: string,
  partyId: string,
  answerSdp: string
): Promise<void> {
  await client.sendEvent(roomId, "m.call.answer" as any, {
    call_id: callId,
    party_id: partyId,
    version: "1",
    answer: { type: "answer", sdp: answerSdp },
    capabilities: {
      "m.call.transferee": false,
      "m.call.dtmf": false,
    },
  });
  logger.info(TAG, `Sent call answer for ${callId}`);
}

export async function sendCandidates(
  client: sdk.MatrixClient,
  roomId: string,
  callId: string,
  partyId: string,
  candidates: Array<{ candidate: string; sdpMLineIndex: number; sdpMid: string }>
): Promise<void> {
  await client.sendEvent(roomId, "m.call.candidates" as any, {
    call_id: callId,
    party_id: partyId,
    version: "1",
    candidates,
  });
  logger.debug(TAG, `Sent ${candidates.length} ICE candidates for ${callId}`);
}

export async function sendHangup(
  client: sdk.MatrixClient,
  roomId: string,
  callId: string,
  reason: string = "user_hangup"
): Promise<void> {
  await client.sendEvent(roomId, "m.call.hangup" as any, {
    call_id: callId,
    party_id: "voip-agent",
    version: "1",
    reason,
  });
  logger.info(TAG, `Sent hangup for ${callId}: ${reason}`);
}
