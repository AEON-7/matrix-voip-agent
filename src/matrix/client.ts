import sdk from "matrix-js-sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";

const TAG = "matrix-client";

export async function createMatrixClient(
  config: Config
): Promise<sdk.MatrixClient> {
  const client = sdk.createClient({
    baseUrl: config.matrix.homeserverUrl,
    userId: config.matrix.userId,
    accessToken: config.matrix.accessToken,
    deviceId: config.matrix.deviceName,
  });

  // Auto-join rooms when invited
  client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
    if (
      member.membership === "invite" &&
      member.userId === config.matrix.userId
    ) {
      logger.info(TAG, `Auto-joining room ${member.roomId}`);
      client.joinRoom(member.roomId).catch((err) => {
        logger.error(TAG, `Failed to join room ${member.roomId}`, err);
      });
    }
  });

  await client.startClient({ initialSyncLimit: 0 });

  await new Promise<void>((resolve) => {
    client.once(sdk.ClientEvent.Sync, (state) => {
      logger.info(TAG, `Initial sync: ${state}`);
      resolve();
    });
  });

  logger.info(TAG, `Connected as ${config.matrix.userId}`);
  return client;
}
