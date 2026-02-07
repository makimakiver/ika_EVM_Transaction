import {
    IkaClient,
    IkaTransaction,
    Curve,
    Hash,
    SignatureAlgorithm,
    UserShareEncryptionKeys,
  } from "@ika.xyz/sdk";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
  import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { objectToUint8Array } from "./utils.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
  
  // Load dWallet data from JSON file
  const DWALLET_RESULT_FILE = process.env.DWALLET_RESULT_FILE || path.resolve(__dirname, '..', 'IkaSetups', 'output', 'dwallet_result.json');
  console.log(`[Config] Loading dWallet data from: ${DWALLET_RESULT_FILE}`);

  let dwalletData: any;
  try {
      const dwalletFileContent = fs.readFileSync(DWALLET_RESULT_FILE, 'utf-8');
      dwalletData = JSON.parse(dwalletFileContent);
      console.log(`[Config] Successfully loaded dWallet data from file`);
  } catch (error) {
      throw new Error(`Failed to load data files: ${error}`);
  }

  const dWalletObjectID = dwalletData.dWalletObjectID;
  const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
  const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";

  // Helper function to add delay
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Retry function with exponential backoff to avoid rate limiting
  async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 1000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        // Check if it's a rate limit error (429)
        if (error?.cause?.status === 429 || error?.status === 429) {
          const delayMs = initialDelay * Math.pow(2, attempt);
          console.log(`Rate limit hit (429). Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
          await delay(delayMs);
        } else {
          // For other errors, throw immediately
          throw error;
        }
      }
    }
    throw lastError;
  }

  export async function ikaSignBytes(
    suiClient: SuiJsonRpcClient,
    ikaClient: IkaClient,
    unsignedBytes: Uint8Array,
    executeTransaction: (tx: Transaction) => Promise<any>,
    signerAddress: string,
    presignId: string,
  ) {
    const tx = new Transaction();
    
    // Extract data from JSON file
    const ROOT_SEED_KEY = objectToUint8Array(dwalletData.rootSeedKey);
    const userPublicOutput = dwalletData.dkgRequestInput?.userPublicOutput
      ? objectToUint8Array(dwalletData.dkgRequestInput.userPublicOutput)
      : undefined;

    if (!userPublicOutput) {
      throw new Error('userPublicOutput not found in dwallet_result.json - did you save the DKG output?');
    }

    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
    const userShareEncryptionKeys = userShareKeys;
    
    // Fetch dWallet from network with retry
    console.log(`[Config] Fetching dWallet: ${dWalletObjectID}...`);
    const dWallet = await retryWithBackoff(async () => {
      return await ikaClient.getDWalletInParticularState(
        dWalletObjectID,
        'Active',
        { timeout: 120000, interval: 3000 }
      );
    });
    console.log(`[Config] dWallet fetched. State: ${dWallet.state?.$kind || 'unknown'}`);
    console.log(`[Debug] dWallet full structure:`, JSON.stringify(dWallet, (key, value) =>
      value instanceof Uint8Array ? `Uint8Array(${value.length})` : value, 2
    ));
    
    // Fetch presign from network (must be Completed) with retry
    console.log(`[Config] Fetching presign: ${presignId}...`);
    const presign = await retryWithBackoff(async () => {
      const p = await ikaClient.getPresignInParticularState(presignId, 'Completed');
      if (!p || p.state?.$kind !== 'Completed') {
        throw new Error(`Presign ${presignId} is not in Completed state`);
      }
      return p;
    });
    console.log(`[Config] Presign fetched. State: ${presign.state?.$kind}`);
    
    // Get IKA coins and SUI coins with retry
    console.log(`[Config] Fetching coins for ${senderAddress}...`);
    const rawUserCoins = await retryWithBackoff(async () => {
      return await suiClient.getAllCoins({ owner: senderAddress });
    });
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    if (!rawUserIkaCoins[0]) {
      throw new Error('No IKA coins found');
    }
    if (!rawUserSuiCoins[0]) {
      throw new Error('No SUI coins found');
    }
    const ikaCoin = tx.object(rawUserIkaCoins[0].coinObjectId);
    const suiCoin = tx.object(rawUserSuiCoins[0].coinObjectId);
    console.log(`[Config] Using IKA coin: ${rawUserIkaCoins[0].coinObjectId}`);
    console.log(`[Config] Using SUI coin: ${rawUserSuiCoins[0].coinObjectId}`);
    
    // Get encrypted user secret key share from dWallet's ObjectTable
    const tableId = dWallet.encrypted_user_secret_key_shares?.id?.id;
    let encryptedUserSecretKeyShare: any | undefined;
    let encryptedUserSecretKeyShareId: string | undefined;

    if (tableId) {
      console.log(`[Config] Fetching encrypted shares from table: ${tableId}...`);
      const dynamicFields = await retryWithBackoff(async () => {
        return await suiClient.getDynamicFields({ parentId: tableId });
      });
      console.log(`[Config] Found ${dynamicFields.data?.length || 0} dynamic field(s)`);

      if (dynamicFields.data && dynamicFields.data.length > 0) {
        encryptedUserSecretKeyShareId = dynamicFields.data[0]?.objectId;
        if (encryptedUserSecretKeyShareId) {
          console.log(`[Config] Fetching encrypted share object: ${encryptedUserSecretKeyShareId}`);
          encryptedUserSecretKeyShare = await retryWithBackoff(async () => {
            return await ikaClient.getEncryptedUserSecretKeyShare(encryptedUserSecretKeyShareId!);
          });
          console.log(`[Config] Using encrypted user secret key share: ${encryptedUserSecretKeyShareId}`);
        }
      }
    }

    if (!encryptedUserSecretKeyShare) {
      throw new Error('Could not find encrypted user secret key share in dWallet');
    }
    
    const ikaTx = new IkaTransaction({
      ikaClient,
      transaction: tx as any,
      userShareEncryptionKeys
    });
  
    // 1) user approves the message
    const messageApproval = ikaTx.approveMessage({
      message: unsignedBytes,
      curve: Curve.SECP256K1,
      dWalletCap: dWallet.dwallet_cap_id,
      signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
      hashScheme: Hash.KECCAK256,
    });
  
    // 2) verify presign cap (presign must be Completed) with retry
    const verifiedPresignCap = await retryWithBackoff(async () => {
      return await ikaTx.verifyPresignCap({ presign });
    });
  
    // 3) request the network signature with retry (this is where the 429 error occurs)
    console.log("[Debug] dWallet state:", dWallet.state?.$kind);
    console.log("[Debug] userPublicOutput length:", userPublicOutput.length);
    
    await ikaTx.requestSign({
        dWallet: dWallet as any, // Type assertion for compatibility
        messageApproval,
        hashScheme: Hash.KECCAK256,
        verifiedPresignCap,
        presign,
        message: unsignedBytes,
        signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
        ikaCoin,
        suiCoin,
        publicOutput: userPublicOutput, // Include the DKG output (SDK expects 'publicOutput')
        // For ZeroTrust encrypted shares:
        encryptedUserSecretKeyShare
    });
    const txJSON = await tx.toJSON();
    console.log("txJSON: ", txJSON);
    // Execute transaction - the sign object will be created by requestSign
    const execRes = await executeTransaction(tx);

    // Debug: Log the full transaction results
    console.log("[Debug] Transaction digest:", execRes.digest);
    console.log("[Debug] Events:", JSON.stringify(execRes.events, null, 2));
    console.log("[Debug] Object changes:", JSON.stringify(execRes.objectChanges, null, 2));

    // Extract the sign object id from transaction events or created objects
    // Look for sign-related events or created objects
    let signObjectId: string | undefined;
    
    // Try to find from events - look for SignRequestEvent
    if (execRes.events) {
      const signEvent = execRes.events.find((event: any) =>
        event.type?.includes('SignRequestEvent')
      );
      if (signEvent?.parsedJson?.sign_id) {
        signObjectId = signEvent.parsedJson.sign_id;
      }
    }
    
    // Try to find from created objects - look for SignSession
    if (!signObjectId && execRes.objectChanges) {
      const signObject = execRes.objectChanges.find((change: any) =>
        change.type === 'created' && change.objectType?.includes('SignSession')
      );
      if (signObject?.objectId) {
        signObjectId = signObject.objectId;
      }
    }
    
    // Try to find from effects (created objects)
    if (!signObjectId && execRes.effects?.created) {
      const signCreated = execRes.effects.created.find((created: any) => 
        created.reference?.objectId && created.owner?.AddressOwner === signerAddress
      );
      if (signCreated?.reference?.objectId) {
        signObjectId = signCreated.reference.objectId;
      }
    }
    
    if (!signObjectId) {
      // If we can't find it, return false and let the caller search more broadly
      console.warn('Could not find sign object ID in transaction results. You may need to search more broadly.');
      return { execRes, signIdTransferredToYou: false, signObjectId: undefined };
    }
    
    console.log(`[Config] Found sign object ID: ${signObjectId}`);
    return { execRes, signIdTransferredToYou: true, signObjectId };
  }
  