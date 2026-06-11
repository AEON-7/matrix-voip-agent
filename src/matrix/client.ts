import OlmModule from "@matrix-org/olm";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { LocalStorageCryptoStore } from "matrix-js-sdk/lib/crypto/store/localStorage-crypto-store.js";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { FileStorage } from "./file-storage.js";

const TAG = "matrix-client";

let olmReady = false;

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function getOlm(): typeof OlmModule {
  const moduleWithDefault = OlmModule as typeof OlmModule & { default?: typeof OlmModule };
  return moduleWithDefault.default ?? OlmModule;
}

async function ensureOlmReady(): Promise<void> {
  const olm = getOlm();
  if (!olmReady) {
    await olm.init();
    olmReady = true;
  }
  (globalThis as typeof globalThis & { Olm: typeof OlmModule }).Olm = olm;
}

function readRecoveryKey(config: Config): string | null {
  const filePath = config.matrix.recoveryKeyFile;
  if (!filePath || !existsSync(filePath)) return null;
  const recoveryKey = readFileSync(filePath, "utf8").trim();
  return recoveryKey.length > 0 ? recoveryKey : null;
}

function decodeConfiguredRecoveryKey(config: Config): Uint8Array | null {
  const recoveryKey = readRecoveryKey(config);
  if (!recoveryKey) return null;
  return decodeRecoveryKey(recoveryKey);
}

function createCryptoCallbacks(config: Config) {
  let cachedRecoveryKey: Uint8Array | null | undefined;

  const getRecoveryKey = (): Uint8Array | null => {
    if (cachedRecoveryKey !== undefined) return cachedRecoveryKey;
    cachedRecoveryKey = decodeConfiguredRecoveryKey(config);
    return cachedRecoveryKey;
  };

  return {
    getBackupKey: async (): Promise<Uint8Array> => {
      const recoveryKey = getRecoveryKey();
      if (!recoveryKey) {
        throw new Error("Matrix recovery key is not configured");
      }
      return recoveryKey;
    },
    getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => {
      const recoveryKey = getRecoveryKey();
      if (!recoveryKey) return null;
      const keyId = Object.keys(keys)[0];
      return keyId ? ([keyId, recoveryKey] as [string, Uint8Array]) : null;
    },
  };
}

async function enableCrypto(config: Config): Promise<{
  cryptoStore: LocalStorageCryptoStore;
  pickleKey: string;
  cryptoCallbacks: ReturnType<typeof createCryptoCallbacks>;
}> {
  await ensureOlmReady();

  const storageFile = join(config.cryptoStorePath, "legacy-localstorage.json");
  const storage = new FileStorage(storageFile);
  logger.info(TAG, `Matrix E2EE enabled with store ${storageFile}`);

  return {
    cryptoStore: new LocalStorageCryptoStore(storage),
    pickleKey:
      config.matrix.cryptoStorePassword ||
      `${config.matrix.userId}:${config.matrix.deviceId}:openclaw-voice`,
    cryptoCallbacks: createCryptoCallbacks(config),
  };
}

async function finishCryptoSetup(
  client: sdk.MatrixClient,
  config: Config
): Promise<void> {
  if (!config.matrix.e2eeEnabled || !client.isCryptoEnabled()) return;

  const recoveryKey = readRecoveryKey(config);
  if (!recoveryKey) {
    logger.warn(
      TAG,
      `Matrix E2EE is active, but no recovery key file exists at ${config.matrix.recoveryKeyFile}`
    );
    return;
  }

  try {
    await client.checkOwnCrossSigningTrust();
    const ready = await client.isCrossSigningReady();
    logger.info(TAG, `Cross-signing ready: ${ready}`);

    if (!ready && config.matrix.autoCrossSign) {
      await client.bootstrapCrossSigning({ setupNewCrossSigning: false });
      await client.checkOwnCrossSigningTrust();
      logger.info(TAG, "Cross-signing bootstrap completed from secret storage");
    }

    if (config.matrix.autoCrossSign) {
      await client.getCrypto()?.crossSignDevice(config.matrix.deviceId);
      logger.info(TAG, `Cross-signed Matrix device ${config.matrix.deviceId}`);
    }
  } catch (err) {
    logger.warn(TAG, `Cross-signing setup did not complete: ${describeError(err)}`);
  }

  if (!config.matrix.restoreKeyBackupOnStart) return;

  try {
    const backupInfo = await client.getKeyBackupVersion();
    if (!backupInfo) {
      logger.info(TAG, "No Matrix key backup is advertised by the homeserver");
      return;
    }

    const result = await client.restoreKeyBackupWithSecretStorage(
      backupInfo,
      undefined,
      undefined,
      {
        progressCallback: (progress) => {
          if (progress.stage === "load_keys") {
            logger.debug(TAG, "Restoring Matrix key backup", progress);
          }
        },
      }
    );
    logger.info(
      TAG,
      `Matrix key backup restored ${result.imported}/${result.total} room keys`
    );
  } catch (err) {
    logger.warn(TAG, `Matrix key backup restore did not complete: ${describeError(err)}`);
  }
}

export async function createMatrixClient(
  config: Config
): Promise<sdk.MatrixClient> {
  let cryptoOptions: Awaited<ReturnType<typeof enableCrypto>> | undefined;

  if (config.matrix.e2eeEnabled) {
    try {
      cryptoOptions = await enableCrypto(config);
    } catch (err) {
      logger.error(TAG, `Failed to initialize Matrix E2EE: ${describeError(err)}`);
      if (config.matrix.e2eeRequired) throw err;
    }
  }

  const client = sdk.createClient({
    baseUrl: config.matrix.homeserverUrl,
    userId: config.matrix.userId,
    accessToken: config.matrix.accessToken,
    deviceId: config.matrix.deviceId,
    cryptoStore: cryptoOptions?.cryptoStore,
    pickleKey: cryptoOptions?.pickleKey,
    cryptoCallbacks: cryptoOptions?.cryptoCallbacks,
  });

  if (cryptoOptions) {
    await client.initCrypto();
    client.setCryptoTrustCrossSignedDevices(true);
    logger.info(TAG, `Initialized Matrix crypto for ${config.matrix.deviceId}`);
  }

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

  await finishCryptoSetup(client, config);

  logger.info(TAG, `Connected as ${config.matrix.userId}`);
  return client;
}
