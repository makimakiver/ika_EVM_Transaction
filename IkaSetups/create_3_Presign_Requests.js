import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getNetworkConfig, IkaClient, IkaTransaction, UserShareEncryptionKeys, Curve, SignatureAlgorithm, SessionsManagerModule, CoordinatorInnerModule } from '@ika.xyz/sdk';
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
// Get dWalletObjectID from JSON file or environment variable
let dWalletObjectID = dwalletData.dWalletObjectID;
if (!dWalletObjectID) {
    dWalletObjectID = process.env.DWALLET_OBJECT_ID;
}
if (!dWalletObjectID) {
    throw new Error('dWalletObjectID not found in JSON file or environment variable');
}
console.log(`[Config] dWalletObjectID: ${dWalletObjectID}`);
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const client = new SuiJsonRpcClient({
    url: "https://api.us1.shinami.com/sui/node/v1/us1_sui_testnet_b909eacf46e54e799a307be45791e726",
    network: 'testnet',
});
const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";
const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
const ikaClient = new IkaClient({
    suiClient: client,
    config: getNetworkConfig('testnet'),
});
const PRESIGN_COUNT = 3;
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
            if (error?.cause?.status === 429 || error?.status === 429) {
                const delayMs = initialDelay * Math.pow(2, attempt);
                console.log(`Rate limit hit (429). Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await delay(delayMs);
            }
            else {
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
/**
 * Create a single presign request, execute it, and wait for completion.
 * Returns the presign result object.
 */
async function createOnePresign(index) {
    const label = `[Presign ${index + 1}/${PRESIGN_COUNT}]`;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${label} Starting presign creation...`);
    console.log(`${"=".repeat(60)}`);
    const tx = new Transaction();
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx,
        userShareEncryptionKeys: userShareKeys
    });
    // Fetch fresh coins for this transaction
    console.log(`${label} Fetching user coins...`);
    const rawUserCoins = await retryWithBackoff(async () => {
        return await client.getAllCoins({ owner: senderAddress });
    });
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    console.log(`${label} IKA coins: ${rawUserIkaCoins.length}, SUI coins: ${rawUserSuiCoins.length}`);
    if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        throw new Error(`${label} Missing required coins (need at least 1 IKA and 2 SUI coins)`);
    }
    const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId);
    console.log(`${label} Using IKA coin: ${rawUserIkaCoins[0].coinObjectId}`);
    console.log(`${label} Using SUI coin: ${rawUserSuiCoins[1].coinObjectId}`);
    // Fetch latest network encryption key
    console.log(`${label} Fetching latest network encryption key...`);
    const dWalletEncryptionKey = await retryWithBackoff(async () => {
        return await ikaClient.getLatestNetworkEncryptionKey();
    });
    console.log(`${label} Encryption key ID: ${dWalletEncryptionKey.id}`);
    // Split fee coin from gas
    const feeCoin = tx.splitCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [1_000_000]);
    // Request global presign
    console.log(`${label} Requesting global presign...`);
    const unverifiedPresignCap = await ikaTx.requestGlobalPresign({
        curve: Curve.SECP256K1,
        signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
        ikaCoin: userIkaCoin,
        suiCoin: feeCoin,
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id
    });
    tx.mergeCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [feeCoin]);
    // Transfer unverified presign cap to sender
    tx.transferObjects([unverifiedPresignCap], senderAddress);
    tx.setSender(senderAddress);
    // Execute transaction
    console.log(`${label} Executing transaction...`);
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEvents: true }
    });
    console.log(`${label} Transaction digest: ${result.digest}`);
    // Wait for confirmation
    console.log(`${label} Waiting for confirmation...`);
    const waitResult = await client.waitForTransaction({
        digest: result.digest,
        options: { showEvents: true }
    });
    // Extract presign ID from events
    const presignEvent = waitResult.events?.find((event) => event.type.includes('PresignRequestEvent'));
    if (!presignEvent) {
        throw new Error(`${label} PresignRequestEvent not found in transaction events`);
    }
    const parsedPresignEvent = SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.PresignRequestEvent).fromBase64(presignEvent.bcs);
    const presignId = parsedPresignEvent.event_data.presign_id;
    console.log(`${label} Presign ID: ${presignId}`);
    // Wait for presign to complete on the network
    console.log(`${label} Waiting for presign to complete (MPC protocol)...`);
    const completedPresign = await retryUntil(() => ikaClient.getPresignInParticularState(presignId, 'Completed'), (presign) => presign !== null, 60, 3000);
    console.log(`${label} Presign completed! State: ${completedPresign.state.$kind}`);
    return {
        timestamp: new Date().toISOString(),
        transactionDigest: result.digest,
        presignId: presignId,
        presignCapId: completedPresign.cap_id,
        dWalletObjectID: dWalletObjectID,
        curve: 'SECP256K1',
        signatureAlgorithm: 'ECDSASecp256k1',
    };
}
async function main() {
    console.log(`[Start] Creating ${PRESIGN_COUNT} presign caps sequentially...`);
    await delay(500);
    console.log('[Init] Initializing Ika Client...');
    await retryWithBackoff(async () => {
        await ikaClient.initialize();
    });
    console.log('[Init] Ika Client initialized');
    const results = [];
    for (let i = 0; i < PRESIGN_COUNT; i++) {
        const presignResult = await createOnePresign(i);
        results.push(presignResult);
        console.log(`\n[Progress] ${i + 1}/${PRESIGN_COUNT} presigns completed`);
        // Small delay between presign requests to avoid rate limiting
        if (i < PRESIGN_COUNT - 1) {
            console.log('[Delay] Waiting 2s before next presign request...');
            await delay(2000);
        }
    }
    // Save all 3 results to a single file
    const outputFilepath = path.join(process.cwd(), 'output', 'presign_3_results.json');
    fs.writeFileSync(outputFilepath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n[Done] All ${PRESIGN_COUNT} presign results saved to: ${outputFilepath}`);
    // Print summary
    console.log('\n--- Summary ---');
    for (let i = 0; i < results.length; i++) {
        console.log(`Presign ${i + 1}: ${results[i].presignId}`);
    }
}
console.log('[Start] Starting 3-presign creation script...');
retryWithBackoff(main, 5, 2000).catch((error) => {
    console.error('[ERROR] Error in main:', error);
    console.error('[ERROR] Stack trace:', error.stack);
    process.exit(1);
});
