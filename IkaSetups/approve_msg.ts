import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import {
    getNetworkConfig,
    IkaClient,
    IkaTransaction,
    UserShareEncryptionKeys,
    createRandomSessionIdentifier,
    Curve,
    SignatureAlgorithm,
    Hash,
    createClassGroupsKeypair,
    prepareDKG,
    prepareDKGAsync,
    SessionsManagerModule,
    CoordinatorInnerModule
} from '@ika.xyz/sdk';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
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
const PRESIGN_RESULT_FILE = process.env.PRESIGN_RESULT_FILE || 'output/presign_result.json';
console.log(`[Config] Loading Presign data from: ${PRESIGN_RESULT_FILE}`);

const DWALLET_RESULT_FILE = process.env.DWALLET_RESULT_FILE || 'output/dwallet_result.json';
console.log(`[Config] Loading dWallet data from: ${DWALLET_RESULT_FILE}`);

let presignResultData: any;
let dWalletData: any;
try {
    const presignFilePath = path.join(process.cwd(), PRESIGN_RESULT_FILE);
    const presignFileContent = fs.readFileSync(presignFilePath, 'utf-8');
    presignResultData = JSON.parse(presignFileContent);
    console.log(`[Config] Successfully loaded Presign data from file`);
    const dwalletFilePath = path.join(process.cwd(), DWALLET_RESULT_FILE);
    const dwalletFileContent = fs.readFileSync(dwalletFilePath, 'utf-8');
    dWalletData = JSON.parse(dwalletFileContent);
    console.log(`[Config] Successfully loaded dWallet data from file`);
} catch (error) {
    throw new Error(`Failed to load dWallet data from ${DWALLET_RESULT_FILE}: ${error}`);
}

// Helper function to convert object with numeric keys to Uint8Array
function objectToUint8Array(obj: any): Uint8Array {
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    return new Uint8Array(keys.map(k => obj[k]));
}

// Extract data from JSON file
const presignId = presignResultData.presignId;
console.log(`[Config] Presign ID: ${presignId}`);
const ROOT_SEED_KEY = objectToUint8Array(dWalletData.rootSeedKey);
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' }); // mainnet / testnet
const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d"
const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
const ikaClient = new IkaClient({
    suiClient: client as any,
    config: getNetworkConfig('testnet'), // mainnet / testnet
});

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
    let lastError: Error;
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
    throw lastError!;
}

// Retry until condition is met (for polling)
async function retryUntil<T>(
    fn: () => Promise<T>,
    condition: (result: T) => boolean,
    maxRetries: number = 30,
    intervalMs: number = 2000
): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const result = await fn();
            if (condition(result)) {
                return result;
            }
            console.log(`[Polling] Attempt ${attempt + 1}/${maxRetries} - condition not met, waiting ${intervalMs}ms...`);
        } catch (error: any) {
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
        transaction: tx as any,
        userShareEncryptionKeys: userShareKeys
    });

    // Wait for presign to complete on the network
    console.log('[Step 21] Waiting for presign to complete on the network...');
    console.log('[Step 21] This may take some time as the MPC protocol runs...');

    const completedPresign = await retryUntil(
        () => ikaClient.getPresignInParticularState(presignId, 'Completed'),
        (presign: any) => presign !== null,
        60,  // max retries
        3000  // interval in ms (3 seconds)
    );

    console.log('[Step 21] Presign completed!');
    console.log(`[Step 21] Presign state: ${completedPresign.state.$kind}`);

    // Save presign info to file for later use in signing
    // ZeroTrust DWallet with unencrypted shares
    // Message to sign
    const message = 'Hello, Ika!';
    const messageBytes = new TextEncoder().encode(message);
    // console.log(`[Step 22] Message bytes: ${messageBytes}`);
    console.log(dWalletData)
    const messageApproval = await ikaTx.approveMessage({
        dWalletCap: presignResultData.dWalletObjectID,
        curve: Curve.SECP256K1,
        signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
        hashScheme: Hash.KECCAK256,
        message: messageBytes,
    });

    console.log(`[Step 22] Message approval created`);
    console.log('[Step 22] Message approval creation process completed successfully!');
    console.log('[Step 22] You can now use this message approval for signing in a separate transaction.');
}

// Execute main with retry logic to avoid concurrency and rate limiting issues
console.log('[Step 0] Starting presign creation script...');
retryWithBackoff(main, 5, 2000).catch((error) => {
    console.error('[ERROR] Error in main:', error);
    console.error('[ERROR] Stack trace:', error.stack);
    process.exit(1);
});