import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getNetworkConfig, IkaClient, IkaTransaction, UserShareEncryptionKeys, Curve, } from '@ika.xyz/sdk';
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
    if (obj instanceof Uint8Array)
        return obj;
    if (Array.isArray(obj))
        return new Uint8Array(obj);
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    return new Uint8Array(keys.map(k => obj[k]));
}
// Extract data from JSON file
const ROOT_SEED_KEY = objectToUint8Array(dwalletData.rootSeedKey);
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
console.log(`[Config] Root seed key loaded (first 10 bytes): ${Buffer.from(ROOT_SEED_KEY.slice(0, 10)).toString('hex')}`);
console.log(`[Config] User public output loaded, length: ${userPublicOutputFromFile.length}`);
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });
// const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";
const ikaClient = new IkaClient({
    suiClient: client,
    config: getNetworkConfig('testnet'),
});
// Helper function to add delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Retry function with exponential backoff
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
/**
 * Activates a dWallet for the sender address
 *
 * 1. Initializes the Ika Client
 * 2. fetches the dWallet from the network from the dWalletObjectID
 * 3. checks if the dWallet is in the AwaitingKeyHolderSignature state
 *  -if Active, then the dWallet is already activated
 *  -if NetworkError, then the dWallet is not found
 * 4. Fetch the dwallet and UserShareEncryptionKeys from the root seed key
 * 5. Creates a new PTB and creates a new IkaTransaction object
 * 6. Fetches the encrypted_user_secret_key_shares table from the dWallet
 * 7. Accepts the encrypted user share
 * 8. Signs and executes the transaction
 */
async function activateDWallet() {
    retryWithBackoff(async () => {
        await ikaClient.initialize();
    });
    // Check current dWallet state
    const dWalletCurrent = await ikaClient.getDWallet(dWalletObjectID);
    const currentState = dWalletCurrent.state?.$kind || 'unknown';
    // Check if already Active
    if (currentState === 'Active') {
        console.log('dWallet is already Active. No activation needed.');
        console.log('[SUCCESS] dWallet is ready for presign operations.');
        return;
    }
    // Check if in AwaitingKeyHolderSignature state
    if (currentState !== 'AwaitingKeyHolderSignature') {
        console.log(`dWallet is in ${currentState} state. Waiting for AwaitingKeyHolderSignature...`);
        try {
            const dWallet = await ikaClient.getDWalletInParticularState(dWalletObjectID, 'AwaitingKeyHolderSignature', { timeout: 300000, interval: 5000 });
            console.log('dWallet reached AwaitingKeyHolderSignature state');
        }
        catch (error) {
            throw new Error(`Failed to reach AwaitingKeyHolderSignature state: ${error.message}`);
        }
    }
    // Fetch dWallet in AwaitingKeyHolderSignature state
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
    const dWallet = await ikaClient.getDWallet(dWalletObjectID);
    const tx = new Transaction();
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx,
        userShareEncryptionKeys: userShareKeys
    });
    const encryptedUserSecretKeySharesId = dWallet.encrypted_user_secret_key_shares?.id?.id;
    if (!encryptedUserSecretKeySharesId) {
        throw new Error('encrypted_user_secret_key_shares table not found on dWallet');
    }
    const dynamicFields = await client.getDynamicFields({ parentId: encryptedUserSecretKeySharesId });
    if (!dynamicFields.data || dynamicFields.data.length === 0) {
        throw new Error('No encrypted user secret key shares found in the table. The network may not have completed DKG yet.');
    }
    const encryptedUserSecretKeyShareId = dynamicFields.data[0]?.objectId;
    if (!encryptedUserSecretKeyShareId) {
        throw new Error('encryptedUserSecretKeyShareId not found');
    }
    // Accept encrypted user share
    await ikaTx.acceptEncryptedUserShare({
        dWallet: dWallet,
        encryptedUserSecretKeyShareId: encryptedUserSecretKeyShareId,
        userPublicOutput: userPublicOutputFromFile,
    });
    const result = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx });
    const waitForTransactionResult = await client.waitForTransaction({ digest: result.digest });
    // Wait for dWallet to become Active
    try {
        const activeDWallet = await ikaClient.getDWalletInParticularState(dWalletObjectID, 'Active', { timeout: 120000, interval: 3000 });
    }
    catch (error) {
        console.log(`Warning: Timeout waiting for Active state. The dWallet may still be processing.`);
        console.log(`You can check the state later and proceed with create_Presign.ts once Active.`);
    }
    console.log('[SUCCESS] You can now run create_Presign.ts to request a presign.');
}
retryWithBackoff(activateDWallet, 5, 2000).catch((error) => {
    console.error('[ERROR] Error in main:', error);
    console.error('[ERROR] Stack trace:', error.stack);
    process.exit(1);
});
