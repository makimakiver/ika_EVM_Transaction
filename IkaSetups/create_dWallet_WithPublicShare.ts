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
    prepareDKGAsync
} from '@ika.xyz/sdk';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import * as dotenv from 'dotenv';
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
	url: getJsonRpcFullnodeUrl('testnet'),
	network: 'testnet',
}); // mainnet / testnet
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
            // Check if it's a rate limit error (429) or a network timeout error
            const isRateLimitError = error?.cause?.status === 429 || error?.status === 429;
            const isNetworkError = error?.message?.includes('Network error') ||
                                   error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                                   error?.cause?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                                   error?.message?.includes('fetch failed');

            if (isRateLimitError || isNetworkError) {
                const delayMs = initialDelay * Math.pow(2, attempt);
                const errorType = isRateLimitError ? 'Rate limit (429)' : 'Network timeout';
                console.log(`${errorType}. Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await delay(delayMs);
            } else {
                // For other errors, throw immediately
                throw error;
            }
        }
    }
    throw lastError!;
}

async function main() {
    // Add delay before initialization to avoid concurrent requests
    await delay(500);
    await retryWithBackoff(async () => {
        await ikaClient.initialize(); // This will initialize the Ika Client and fetch the Ika protocol state and objects.
    });
    
    // Generate a random seed
    const rootSeedKey = new Uint8Array(32);
    crypto.getRandomValues(rootSeedKey);
    
    // Create UserShareEncryptionKeys from the seed
    // IMPORTANT: Use the curve that matches your dWallet's curve
    const tx = new Transaction();
    
    const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(rootSeedKey, Curve.SECP256K1);
    const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx as any,
        userShareEncryptionKeys: userShareKeys
    });
    // Get user's IKA coin and SUI coin for transaction fees
    const rawUserCoins = await client.getAllCoins({
        owner: senderAddress
    })
    console.log(rawUserCoins);
    const rawUserIkaCoins = rawUserCoins.data.filter((coin) => coin.coinType === testnetIkaCoinType);
    const rawUserSuiCoins = rawUserCoins.data.filter((coin) => coin.coinType === '0x2::sui::SUI');
    // const rawUserIkaCoins = rawUserCoins.data.filter() //some filtering logic inside it
    if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        throw new Error('Missing required coins');
    }
    const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId); // User's IKA coin object ID
    const userSuiCoin = tx.object(rawUserSuiCoins[1].coinObjectId); // User's SUI coin object ID
    // Create session identifier
    const sessionId = createRandomSessionIdentifier();
    // Register an encryption key before the DKG, or if you did already you can skip this step
    await ikaTx.registerEncryptionKey({
        curve: Curve.SECP256K1,
    });
    const dWalletEncryptionKey = await retryWithBackoff(async () => {
        return await ikaClient.getLatestNetworkEncryptionKey();
    });
    // Prepare DKG data
    const dkgRequestInput = await prepareDKGAsync(
        ikaClient,
        Curve.SECP256K1,
        userShareKeys,
        sessionId,
        senderAddress,
    );
    const sessionIdentifier = ikaTx.createSessionIdentifier();
    console.log("dWalletNetworkEncryptionKeyId: ", dWalletEncryptionKey.id);
    // prepareDKGAsync returns fields for requestDWalletDKG (encrypted shares)
    // For requestDWalletDKGWithPublicUserShare, we need to map the fields:
    // - publicKeyShareAndProof comes from userDKGMessage (contains public key share and proof)
    // - publicUserSecretKeyShare comes from userSecretKeyShare (the secret share, made public in this flow)
    // - userPublicOutput is available directly
    const [dwalletCap] = await ikaTx.requestDWalletDKGWithPublicUserShare({
        sessionIdentifier,
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id, // id of dWalletEncryptionKey is the network encryption key ID
        curve: Curve.SECP256K1, // or Curve.SECP256R1, Curve.ED25519, etc.
        publicKeyShareAndProof: dkgRequestInput.userDKGMessage, // userDKGMessage contains the public key share and proof
        publicUserSecretKeyShare: dkgRequestInput.userSecretKeyShare, // Use the secret key share directly (public in this flow)
        userPublicOutput: dkgRequestInput.userPublicOutput,
        ikaCoin: userIkaCoin,
        suiCoin: userSuiCoin
    });  
    tx.transferObjects([dwalletCap as TransactionObjectArgument], senderAddress);
    // Note: The remaining balance from suiCoin after splitCoins is automatically returned
    // No need to transfer userSuiCoinRemaining as splitCoins consumes the original coin
    // tx.transferObjects([userSuiCoin], senderAddress);
    // tx.setSender(senderAddress);
    const txJSON = await tx.toJSON();
    console.log("txJSON: ", txJSON);
    const result = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx });
    const waitForTransactionResult = await client.waitForTransaction({ digest: result.digest });
    console.log("waitForTransactionResult: ", waitForTransactionResult);
}

// Execute main with retry logic to avoid concurrency and rate limiting issues
retryWithBackoff(main, 5, 2000).catch((error) => {
    console.error('Error in main:', error);
    process.exit(1);
});