import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
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
// Load dWallet data
const DWALLET_RESULT_FILE = process.env.DWALLET_RESULT_FILE || 'output/dwallet_result.json';
let dwalletData;
try {
    const filePath = path.join(process.cwd(), DWALLET_RESULT_FILE);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    dwalletData = JSON.parse(fileContent);
}
catch (error) {
    throw new Error(`Failed to load dWallet data from ${DWALLET_RESULT_FILE}: ${error}`);
}
function objectToUint8Array(obj) {
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    return new Uint8Array(keys.map(k => obj[k]));
}
const ROOT_SEED_KEY = objectToUint8Array(dwalletData.rootSeedKey);
let dWalletObjectID = dwalletData.dWalletObjectID;
if (!dWalletObjectID) {
    dWalletObjectID = process.env.DWALLET_OBJECT_ID;
}
if (!dWalletObjectID) {
    throw new Error('dWalletObjectID not found in JSON file or environment variable');
}
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
const PRESIGN_FILE = path.join(process.cwd(), 'output', 'presign_3_results.json');
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
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
async function createOnePresign(label) {
    console.log(`${label} Building transaction...`);
    const tx = new Transaction();
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx,
        userShareEncryptionKeys: userShareKeys
    });
    // Fetch fresh coins
    console.log(`${label} Fetching user coins...`);
    const rawUserCoins = await retryWithBackoff(async () => {
        return await client.getAllCoins({ owner: senderAddress });
    });
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        throw new Error(`${label} Missing required coins (need at least 1 IKA and 2 SUI coins)`);
    }
    const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId);
    // Fetch latest network encryption key
    console.log(`${label} Fetching latest network encryption key...`);
    const dWalletEncryptionKey = await retryWithBackoff(async () => {
        return await ikaClient.getLatestNetworkEncryptionKey();
    });
    const feeCoin = tx.splitCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [1_000_000]);
    console.log(`${label} Requesting global presign...`);
    const unverifiedPresignCap = await ikaTx.requestGlobalPresign({
        curve: Curve.SECP256K1,
        signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
        ikaCoin: userIkaCoin,
        suiCoin: feeCoin,
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id
    });
    tx.mergeCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [feeCoin]);
    tx.transferObjects([unverifiedPresignCap], senderAddress);
    tx.setSender(senderAddress);
    console.log(`${label} Executing transaction...`);
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEvents: true }
    });
    console.log(`${label} Transaction digest: ${result.digest}`);
    console.log(`${label} Waiting for confirmation...`);
    const waitResult = await client.waitForTransaction({
        digest: result.digest,
        options: { showEvents: true }
    });
    const presignEvent = waitResult.events?.find((event) => event.type.includes('PresignRequestEvent'));
    if (!presignEvent) {
        throw new Error(`${label} PresignRequestEvent not found in transaction events`);
    }
    const parsedPresignEvent = SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.PresignRequestEvent).fromBase64(presignEvent.bcs);
    const presignId = parsedPresignEvent.event_data.presign_id;
    console.log(`${label} Presign ID: ${presignId}`);
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
    // Read existing presign results
    console.log(`[Init] Reading presign results from: ${PRESIGN_FILE}`);
    let presignResults;
    try {
        const fileContent = fs.readFileSync(PRESIGN_FILE, 'utf-8');
        presignResults = JSON.parse(fileContent);
    }
    catch (error) {
        throw new Error(`Failed to read ${PRESIGN_FILE}: ${error}`);
    }
    // Find indices of used presigns
    const usedIndices = presignResults
        .map((entry, index) => entry.used === true ? index : -1)
        .filter(index => index !== -1);
    if (usedIndices.length === 0) {
        console.log('[Done] No used presign caps found. Nothing to replace.');
        return;
    }
    console.log(`[Init] Found ${usedIndices.length} used presign cap(s) at index(es): ${usedIndices.join(', ')}`);
    await delay(500);
    console.log('[Init] Initializing Ika Client...');
    await retryWithBackoff(async () => {
        await ikaClient.initialize();
    });
    console.log('[Init] Ika Client initialized');
    for (let i = 0; i < usedIndices.length; i++) {
        const idx = usedIndices[i];
        const label = `[Replace ${i + 1}/${usedIndices.length} (index ${idx})]`;
        console.log(`\n${"=".repeat(60)}`);
        console.log(`${label} Replacing used presign cap...`);
        console.log(`${label} Old presignId: ${presignResults[idx].presignId}`);
        console.log(`${"=".repeat(60)}`);
        const newPresign = await createOnePresign(label);
        // Replace the used entry with the new one (no "used" flag)
        presignResults[idx] = newPresign;
        // Save after each replacement so progress is preserved
        fs.writeFileSync(PRESIGN_FILE, JSON.stringify(presignResults, null, 2), 'utf-8');
        console.log(`${label} Replaced and saved to ${PRESIGN_FILE}`);
        if (i < usedIndices.length - 1) {
            console.log('[Delay] Waiting 2s before next replacement...');
            await delay(2000);
        }
    }
    console.log(`\n[Done] Successfully replaced ${usedIndices.length} used presign cap(s).`);
    console.log('\n--- Updated Presigns ---');
    for (let i = 0; i < presignResults.length; i++) {
        const status = usedIndices.includes(i) ? '(NEW)' : '(unchanged)';
        console.log(`  Presign ${i + 1} ${status}: ${presignResults[i].presignId}`);
    }
}
console.log('[Start] Starting used presign replacement script...');
retryWithBackoff(main, 5, 2000).catch((error) => {
    console.error('[ERROR] Error in main:', error);
    console.error('[ERROR] Stack trace:', error.stack);
    process.exit(1);
});
