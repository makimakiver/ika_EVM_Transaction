import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getNetworkConfig, IkaClient, IkaTransaction, UserShareEncryptionKeys, createRandomSessionIdentifier, Curve, SignatureAlgorithm, Hash, createClassGroupsKeypair, prepareDKG, prepareDKGAsync, SessionsManagerModule, CoordinatorInnerModule } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const PRIVATE_KEY = process.env.SUI_PRIVATE_KEY;
if (!PRIVATE_KEY) {
    throw new Error('SUI_PRIVATE_KEY is not set');
}
// Load data from JSON file
const DWALLET_RESULT_FILE = process.env.DWALLET_RESULT_FILE || 'output/dwallet_result.json';
console.log(`[Config] Loading dWallet data from: ${DWALLET_RESULT_FILE}`);
let dwalletData;
try {
    const filePath = path.join(process.cwd(), DWALLET_RESULT_FILE);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    dwalletData = JSON.parse(fileContent);
    console.log(`[Config] Successfully loaded dWallet data from file`);
}
catch (error) {
    throw new Error(`Failed to load dWallet data from ${DWALLET_RESULT_FILE}: ${error}`);
}
// Helper function to convert object with numeric keys to Uint8Array
function objectToUint8Array(obj) {
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    return new Uint8Array(keys.map(k => obj[k]));
}
// Extract data from JSON file
const ROOT_SEED_KEY = objectToUint8Array(dwalletData.rootSeedKey);
const sessionIdFromFile = objectToUint8Array(dwalletData.sessionId);
const userPublicOutputFromFile = objectToUint8Array(dwalletData.dkgRequestInput.userPublicOutput);
// Get dWalletObjectID from JSON file or environment variable
let dWalletObjectID = dwalletData.dWalletObjectID;
if (!dWalletObjectID) {
    dWalletObjectID = process.env.DWALLET_OBJECT_ID;
}
if (!dWalletObjectID) {
    throw new Error('dWalletObjectID not found in JSON file or environment variable');
}
console.log(`[Config] dWalletObjectID: ${dWalletObjectID}`);
console.log(`[Config] Session ID loaded: ${sessionIdFromFile}`);
console.log(`[Config] Root seed key loaded: ${ROOT_SEED_KEY}`);
console.log(`[Config] User public output loaded: ${userPublicOutputFromFile}`);
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const client = new SuiJsonRpcClient({
    url: "https://api.us1.shinami.com/sui/node/v1/us1_sui_testnet_b909eacf46e54e799a307be45791e726",
    network: 'testnet',
});
const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";
const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
const ikaClient = new IkaClient({
    suiClient: client,
    config: getNetworkConfig('testnet'), // mainnet / testnet
});
// Helper function to add delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Retry function with exponential backoff to avoid rate limiting
async function retryWithBackoff(fn, maxRetries = 5, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            // Check if it's a rate limit error (429)
            if (error?.cause?.status === 429 || error?.status === 429) {
                const delayMs = initialDelay * Math.pow(2, attempt);
                console.log(`Rate limit hit (429). Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await delay(delayMs);
            }
            else {
                // For other errors, throw immediately
                throw error;
            }
        }
    }
    throw lastError;
}
// Retry until condition is met (for polling)
async function retryUntil(fn, condition, maxRetries = 30, intervalMs = 2000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const result = await fn();
            if (condition(result)) {
                return result;
            }
            console.log(`[Polling] Attempt ${attempt + 1}/${maxRetries} - condition not met, waiting ${intervalMs}ms...`);
        }
        catch (error) {
            console.log(`[Polling] Attempt ${attempt + 1}/${maxRetries} - error: ${error.message}, waiting ${intervalMs}ms...`);
        }
        await delay(intervalMs);
    }
    throw new Error(`Condition not met after ${maxRetries} attempts`);
}
async function main() {
    console.log('[Step 1] Starting presign creation process...');
    // Add delay before initialization to avoid concurrent requests
    console.log('[Step 2] Adding initial delay (500ms)...');
    await delay(500);
    console.log('[Step 3] Initializing Ika Client...');
    await retryWithBackoff(async () => {
        await ikaClient.initialize(); // This will initialize the Ika Client and fetch the Ika protocol state and objects.
    });
    console.log('[Step 3] Ika Client initialized successfully');
    const tx = new Transaction();
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
    console.log('[Step 5] UserShareEncryptionKeys created');
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx,
        userShareEncryptionKeys: userShareKeys
    });
    // Get user's IKA coin and SUI coin for transaction fees
    console.log('[Step 6] Fetching user coins...');
    const rawUserCoins = await client.getAllCoins({
        owner: senderAddress
    });
    console.log(`[Step 6] Total coins found: ${rawUserCoins.data.length}`);
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    console.log(`[Step 6] IKA coins found: ${rawUserIkaCoins.length}`);
    console.log(`[Step 6] SUI coins found: ${rawUserSuiCoins.length}`);
    // const rawUserIkaCoins = rawUserCoins.data.filter() //some filtering logic inside it
    if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        throw new Error('Missing required coins');
    }
    const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId); // User's IKA coin object ID
    const userSuiCoin = tx.object(rawUserSuiCoins[1].coinObjectId); // User's SUI coin object ID
    console.log(`[Step 6] Using IKA coin: ${rawUserIkaCoins[0].coinObjectId}`);
    console.log(`[Step 6] Using SUI coin: ${rawUserSuiCoins[1].coinObjectId}`);
    // Use the session ID from dWallet creation (loaded from JSON file)
    console.log('[Step 7] Using session ID from dWallet creation file...');
    const sessionId = sessionIdFromFile;
    console.log(`[Step 7] Session ID: ${Buffer.from(sessionId).toString('hex').substring(0, 16)}...`);
    // // Register an encryption key before the DKG, or if you did already you can skip this step
    // console.log('[Step 8] Registering encryption key...');
    // await ikaTx.registerEncryptionKey({
    //     curve: Curve.SECP256K1,
    // });
    // console.log('[Step 8] Encryption key registered');
    console.log('[Step 9] Fetching latest network encryption key...');
    const dWalletEncryptionKey = await ikaClient.getLatestNetworkEncryptionKey();
    console.log(`[Step 9] dWalletNetworkEncryptionKeyId: ${dWalletEncryptionKey.id}`);
    console.log(`[Step 12] Fetching dWallet: ${dWalletObjectID}...`);
    const dWallet = await retryWithBackoff(async () => {
        return await ikaClient.getDWallet(dWalletObjectID);
    });
    console.log(`[Step 12] dWallet fetched. State: ${dWallet.state?.$kind || 'unknown'}`);
    console.log('[Step 13] Using user public output from dWallet creation file...');
    // Use the userPublicOutput from the JSON file instead of regenerating
    const dkgRequestInput = {
        userPublicOutput: userPublicOutputFromFile
    };
    console.log(`[Step 13] User public output loaded, length: ${dkgRequestInput.userPublicOutput.length}`);
    console.log('[Step 13] dkgRequestInput.userPublicOutput:', dkgRequestInput.userPublicOutput);
    // Get the encryptedUserSecretKeyShareId from the dWallet
    const encryptedUserSecretKeyShareId = dWallet.encrypted_user_secret_key_shares?.id?.id;
    console.log(`[Step 13] encryptedUserSecretKeyShareId: ${encryptedUserSecretKeyShareId}`);
    if (!encryptedUserSecretKeyShareId) {
        throw new Error(`Missing encryptedUserSecretKeyShareId`);
    }
    // console.log('[Step 13] Accepting encrypted user share...');
    // await ikaTx.acceptEncryptedUserShare({
    //     dWallet: dWallet,
    //     encryptedUserSecretKeyShareId: encryptedUserSecretKeyShareId,
    //     userPublicOutput: dkgRequestInput.userPublicOutput,
    // });
    // console.log('[Step 13] Encrypted user share accepted');
    const feeCoin = tx.splitCoins(tx.gas, [1_000_000]); // keep this
    console.log('[Step 14] Requesting presign with ECDSASecp256k1 algorithm...');
    const unverifiedPresignCap = await ikaTx.requestGlobalPresign({
        curve: Curve.SECP256K1, // Use the fetched DWallet object with state
        signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
        ikaCoin: userIkaCoin,
        suiCoin: feeCoin, // User's SUI coin object ID
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id
    });
    // Presign with specific dWallet
    // const unverifiedPresignCap = await ikaTx.requestPresign({
    //     dWallet: dWallet, // Use the fetched DWallet object with state
    //     signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    //     ikaCoin: userIkaCoin,
    //     suiCoin: feeCoin // User's SUI coin object ID
    // });
    tx.mergeCoins(tx.gas, [feeCoin]);
    console.log(`[Step 14] Unverified presign cap created`);
    // NOTE: Cannot verify presign in the same transaction!
    // The presign must complete on the network (MPC computation) first.
    // Transfer unverified cap, wait for completion, then verify in a separate transaction.
    console.log('[Step 15] Transferring UNVERIFIED presign cap to sender...');
    tx.transferObjects([unverifiedPresignCap], senderAddress);
    console.log('[Step 15] Transfer added to transaction');
    console.log('[Step 16] Setting transaction sender...');
    tx.setSender(senderAddress);
    console.log(`[Step 16] Sender set: ${senderAddress}`);
    console.log('[Step 17] Converting transaction to JSON...');
    const txJSON = await tx.toJSON();
    console.log('[Step 17] Transaction JSON prepared');
    console.log("txJSON: ", txJSON);
    console.log('[Step 18] Signing and executing transaction...');
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEvents: true }
    });
    console.log(`[Step 18] Transaction executed. Digest: ${result.digest}`);
    console.log('[Step 19] Waiting for transaction confirmation...');
    const waitForTransactionResult = await client.waitForTransaction({
        digest: result.digest,
        options: { showEvents: true }
    });
    console.log('[Step 19] Transaction confirmed!');
    // Extract presign ID from the event
    console.log('[Step 20] Extracting presign ID from events...');
    const presignEvent = waitForTransactionResult.events?.find((event) => event.type.includes('PresignRequestEvent'));
    if (!presignEvent) {
        throw new Error('PresignRequestEvent not found in transaction events');
    }
    const parsedPresignEvent = SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.PresignRequestEvent).fromBase64(presignEvent.bcs);
    const presignId = parsedPresignEvent.event_data.presign_id;
    console.log(`[Step 20] Presign ID: ${presignId}`);
    // Wait for presign to complete on the network
    console.log('[Step 21] Waiting for presign to complete on the network...');
    console.log('[Step 21] This may take some time as the MPC protocol runs...');
    const completedPresign = await retryUntil(() => ikaClient.getPresignInParticularState(presignId, 'Completed'), (presign) => presign !== null, 60, // max retries
    3000 // interval in ms (3 seconds)
    );
    console.log('[Step 21] Presign completed!');
    console.log(`[Step 21] Presign state: ${completedPresign.state.$kind}`);
    // Save presign info to file for later use in signing
    const presignResult = {
        timestamp: new Date().toISOString(),
        transactionDigest: result.digest,
        presignId: presignId,
        presignCapId: completedPresign.cap_id,
        dWalletObjectID: dWalletObjectID,
        curve: 'SECP256K1',
        signatureAlgorithm: 'ECDSASecp256k1',
    };
    const presignFilename = `presign_result.json`;
    const presignFilepath = path.join(process.cwd(), 'output', presignFilename);
    fs.writeFileSync(presignFilepath, JSON.stringify(presignResult, null, 2), 'utf-8');
    console.log(`[Step 22] Presign result saved to: ${presignFilepath}`);
    console.log('[Step 22] Presign creation process completed successfully!');
    console.log('[Step 22] You can now use this presign for signing in a separate transaction.');
}
// Execute main with retry logic to avoid concurrency and rate limiting issues
console.log('[Step 0] Starting presign creation script...');
retryWithBackoff(main, 5, 2000).catch((error) => {
    console.error('[ERROR] Error in main:', error);
    console.error('[ERROR] Stack trace:', error.stack);
    process.exit(1);
});
// ZeroTrust DWallet with unencrypted shares
