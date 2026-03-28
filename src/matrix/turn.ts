import sdk from "matrix-js-sdk";
import { logger } from "../logger.js";

const TAG = "turn";

export interface TurnCredentials {
  username: string;
  password: string;
  uris: string[];
  ttl: number;
}

export async function fetchTurnCredentials(
  client: sdk.MatrixClient
): Promise<TurnCredentials> {
  const resp = await client.turnServer();

  if (!resp || !resp.uris || resp.uris.length === 0) {
    throw new Error("No TURN servers returned by homeserver");
  }

  logger.info(TAG, `Got TURN credentials, ${resp.uris.length} URIs, TTL=${resp.ttl}s`);
  logger.debug(TAG, "TURN URIs", resp.uris);

  return {
    username: resp.username,
    password: resp.password,
    uris: resp.uris,
    ttl: resp.ttl,
  };
}

export function turnToIceServers(
  creds: TurnCredentials
): Array<{ urls: string; username: string; credential: string }> {
  return creds.uris.map((uri) => ({
    urls: uri,
    username: creds.username,
    credential: creds.password,
  }));
}
