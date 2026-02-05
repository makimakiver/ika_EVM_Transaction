import "dotenv/config";
import { ethers } from "ethers";
import { buildUnsignedSetValueTx } from "./buildUnsigned.js";
import { ikaSignBytes } from "./ikaRequestSign.js";
import { fetchIkaSignature } from "./ikaFetch.js";
import { broadcastSignedTx } from "./evmBroadcast.js";
import { Curve, getNetworkConfig, IkaClient, publicKeyFromDWalletOutput } from "@ika.xyz/sdk";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const DWALLET_RESULT_FILE = process.env.DWALLET_RESULT_FILE || path.resolve(__dirname, '..', 'IkaSetups', 'output', 'dwallet_result.json');
const dWalletData = JSON.parse(fs.readFileSync(DWALLET_RESULT_FILE, 'utf8'));
function objectToUint8Array(obj) {
    // Handle both object format (from JSON) and already-converted Uint8Array
    if (obj instanceof Uint8Array) {
        return obj;
    }
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    // Ensure all values are numbers
    const values = keys.map(k => {
        const val = obj[k];
        if (typeof val !== 'number') {
            throw new Error(`Expected number at index ${k}, got ${typeof val}: ${val}`);
        }
        return val;
    });
    return new Uint8Array(values);
}
async function main() {
    console.log("RPC_URL: ", process.env.RPC_URL);
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const suiClient = new SuiJsonRpcClient({
        url: "https://api.us1.shinami.com/sui/node/v1/us1_sui_testnet_b909eacf46e54e799a307be45791e726",
        network: 'testnet',
    });
    const ikaClient = new IkaClient({
        suiClient: suiClient,
        config: getNetworkConfig('testnet'), // mainnet / testnet
    });
    // Initialize Ika Client
    await ikaClient.initialize();
    // Setup signer for executing transactions
    const PRIVATE_KEY = process.env.SUI_PRIVATE_KEY;
    if (!PRIVATE_KEY) {
        throw new Error('SUI_PRIVATE_KEY is not set');
    }
    const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
    const signerAddress = keypair.toSuiAddress();
    // Create executeTransaction function
    const executeTransaction = async (tx) => {
        const result = await suiClient.signAndExecuteTransaction({
            signer: keypair,
            transaction: tx,
        });
        // Wait for transaction and get full details including events and object changes
        const txDetails = await suiClient.waitForTransaction({
            digest: result.digest,
            options: {
                showEvents: true,
                showObjectChanges: true,
                showEffects: true,
            },
        });
        return txDetails;
    };
    const dWalletObjectID = "0xf8fb506ac36100ecf1231affe1473e10720294d8044fed55cb0864891b502924";
    // This is the EVM address that corresponds to your Ika dWallet (or the "from" you expect)
    // Wait for DKG to complete
    // Fetch the active dWallet
    const dWallet = await ikaClient.getDWalletInParticularState(dWalletObjectID, 'Active', { timeout: 120000, interval: 3000 });
    // Get public key from the dWallet's public_output (complete DKG output)
    if (!dWallet.state?.Active?.public_output) {
        throw new Error('dWallet is not in Active state or missing public_output');
    }
    // Convert to Uint8Array if needed
    const dWalletPublicOutput = dWallet.state.Active.public_output instanceof Uint8Array
        ? dWallet.state.Active.public_output
        : new Uint8Array(dWallet.state.Active.public_output);
    console.log("dWalletPublicOutput length:", dWalletPublicOutput.length);
    const publicKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, dWalletPublicOutput);
    console.log("publicKey length:", publicKey.length);
    console.log("publicKey hex:", ethers.hexlify(publicKey));
    // Convert public key to Ethereum address
    // For secp256k1: need 64-byte uncompressed x,y coordinates (no prefix)
    // - 33 bytes: compressed (02/03 prefix + 32 bytes x) - needs decompression
    // - 64 bytes: uncompressed without prefix (x,y)
    // - 65 bytes: uncompressed with 04 prefix (04 + x,y)
    let uncompressedPubKey;
    if (publicKey.length === 33) {
        // Compressed public key - decompress using ethers SigningKey
        const decompressed = ethers.SigningKey.computePublicKey(publicKey, false);
        // Returns 65 bytes with 04 prefix, we need 64 bytes without prefix
        uncompressedPubKey = ethers.getBytes(decompressed).slice(1);
        console.log("Decompressed public key (64 bytes):", ethers.hexlify(uncompressedPubKey));
    }
    else if (publicKey.length === 65) {
        // Uncompressed with 04 prefix - remove prefix
        uncompressedPubKey = publicKey.slice(1);
    }
    else if (publicKey.length === 64) {
        // Already uncompressed without prefix
        uncompressedPubKey = publicKey;
    }
    else {
        throw new Error(`Unexpected public key length: ${publicKey.length}`);
    }
    const addressBytes = ethers.getBytes(ethers.keccak256(ethers.hexlify(uncompressedPubKey))).slice(-20);
    const expectedFrom = ethers.getAddress(ethers.hexlify(addressBytes));
    console.log("Ethereum address:", expectedFrom);
    const { populated, unsignedBytes, digest } = await buildUnsignedSetValueTx(provider, expectedFrom, 123);
    console.log("EVM digest to be signed:", digest);
    // 1) Create sign request on Ika (Sui PTB)
    const { execRes, signIdTransferredToYou, signObjectId } = await ikaSignBytes(suiClient, ikaClient, unsignedBytes, executeTransaction, signerAddress);
    // 2) Use the sign object id from the transaction results
    let finalSignObjectId;
    if (signObjectId) {
        finalSignObjectId = signObjectId;
    }
    else {
        // Fallback: try to extract from events if not found
        const fallbackSignId = execRes.events?.find((event) => event.type === 'transferred_object' && event.objectType === 'sign')?.objectId;
        if (!fallbackSignId) {
            throw new Error("Sign object id not found in transaction results");
        }
        console.log(`[Config] Using fallback sign object ID: ${fallbackSignId}`);
        finalSignObjectId = fallbackSignId;
    }
    // 3) Wait/poll until Completed then fetch signature
    const rawSig = await fetchIkaSignature(ikaClient, finalSignObjectId);
    // 4) Attach signature + send to EVM
    const txHash = await broadcastSignedTx(provider, populated, unsignedBytes, rawSig, expectedFrom);
    console.log("Sent tx hash:", txHash);
}
main().catch(console.error);
