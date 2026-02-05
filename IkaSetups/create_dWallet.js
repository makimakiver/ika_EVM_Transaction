import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getNetworkConfig, IkaClient, IkaTransaction, UserShareEncryptionKeys, createRandomSessionIdentifier, Curve, SignatureAlgorithm, Hash, createClassGroupsKeypair, prepareDKG, prepareDKGAsync } from '@ika.xyz/sdk';
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
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const client = new SuiJsonRpcClient({
    url: "https://api.us1.shinami.com/sui/node/v1/us1_sui_testnet_b909eacf46e54e799a307be45791e726",
    network: 'testnet',
});
const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";
const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
// Note: Type assertion needed due to @ika.xyz/sdk using @mysten/sui v1.x internally
const ikaClient = new IkaClient({
    suiClient: client,
    config: getNetworkConfig('testnet'), // mainnet / testnet
});
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Retry function with exponential backoff to avoid rate limiting
 *
 * @param fn - The function to retry
 * @param maxRetries - The maximum number of retries
 * @param initialDelay - The initial delay in milliseconds
 * @returns The result of the function
 */
async function retryWithBackoff(fn, maxRetries = 5, initialDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            // Check if it's a rate limit error (429 or -32010)
            const isRateLimit = error?.cause?.status === 429 ||
                error?.status === 429 ||
                error?.cause?.code === -32010 ||
                error?.message?.includes('Too many requests');
            if (isRateLimit) {
                const delayMs = 15000; // Increased delay for rate limiting
                console.log(`Rate limit hit. Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
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
/**
 * Creates a dWallet for the sender address
 *
 * 1. Initializes the Ika Client
 * 2. Creates UserShareEncryptionKeys from randomnised seed key
 * 3. Creates a new PTB
 * 5. Gets user's IKA coin and SUI coin for transaction fees
 * 6. Creates a random session identifier
 * 7. Registers an encryption key
 * 8. Prepares DKG data using prepareDKGAsync
 * 9. Requests a dWallet DKG (distributed key generation)
 * 10. Transfers the dWallet cap to the sender address
 * 11. Executes the transaction
 * 12. Saves the results to a json file (dwallet_result.json)
 */
async function createDWallet() {
    await retryWithBackoff(async () => {
        await ikaClient.initialize();
    });
    const rootSeedKey = new Uint8Array(32);
    crypto.getRandomValues(rootSeedKey);
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(rootSeedKey, Curve.SECP256K1);
    const tx = new Transaction();
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx,
        userShareEncryptionKeys: userShareKeys
    });
    const rawUserCoins = await client.getAllCoins({
        owner: senderAddress
    });
    // console.log(rawUserCoins);
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    // const rawUserIkaCoins = rawUserCoins.data.filter() //some filtering logic inside it
    if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        throw new Error('Missing required coins');
    }
    const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId); // User's IKA coin object ID
    const userSuiCoin = tx.object(rawUserSuiCoins[1].coinObjectId); // User's SUI coin object ID
    const sessionId = createRandomSessionIdentifier();
    await ikaTx.registerEncryptionKey({
        curve: Curve.SECP256K1,
    });
    const dWalletEncryptionKey = await retryWithBackoff(async () => {
        return await ikaClient.getLatestNetworkEncryptionKey();
    });
    const dkgRequestInput = await retryWithBackoff(async () => {
        return await prepareDKGAsync(ikaClient, Curve.SECP256K1, userShareKeys, sessionId, senderAddress);
    });
    const [dwalletCap, _sign_ID] = await ikaTx.requestDWalletDKG({
        dkgRequestInput: dkgRequestInput,
        sessionIdentifier: ikaTx.registerSessionIdentifier(sessionId),
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id, // id of dWalletEncryptionKey is the network encryption key ID
        curve: Curve.SECP256K1, // or Curve.SECP256R1, Curve.ED25519, etc.
        ikaCoin: userIkaCoin,
        suiCoin: userSuiCoin
    });
    tx.transferObjects([dwalletCap], senderAddress);
    tx.setSender(senderAddress);
    // Sign and execute the transaction
    const result = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx });
    const waitForTransactionResult = await client.waitForTransaction({ digest: result.digest });
    const resultData = {
        timestamp: new Date().toISOString(),
        transactionDigest: result.digest,
        waitForTransactionResult: waitForTransactionResult,
        sessionId: sessionId,
        rootSeedKey: rootSeedKey,
        dkgRequestInput: {
            userPublicOutput: dkgRequestInput.userPublicOutput,
        },
        senderAddress: senderAddress,
        dWalletNetworkEncryptionKeyId: dWalletEncryptionKey.id,
        dWalletObjectID: "",
    };
    const outputDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const filename = `dwallet_result.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(resultData, null, 2), 'utf-8');
    console.log(`Results saved to: ${filepath}`);
}
// Execute main with retry logic to avoid concurrency and rate limiting issues
retryWithBackoff(createDWallet, 5, 2000).catch((error) => {
    console.error('Error in main:', error);
    process.exit(1);
});
