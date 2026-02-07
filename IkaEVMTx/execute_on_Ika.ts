import "dotenv/config";
import { ethers } from "ethers";
import { buildUnsignedApproveUSDC, buildUnsignedDeposit, buildUnsignedPlaceOrder } from "./buildUnsigned.js";
import { ikaSignBytes } from "./ikaRequestSign.js";
import { fetchIkaSignature } from "./ikaFetch.js";
import { broadcastSignedTx } from "./evmBroadcast.js";
import {
  Curve,
  getNetworkConfig,
  IkaClient,
  IkaTransaction,
  UserShareEncryptionKeys,
  SignatureAlgorithm,
  SessionsManagerModule,
  CoordinatorInnerModule,
  publicKeyFromDWalletOutput,
} from "@ika.xyz/sdk";
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

const PRESIGN_3_FILE = process.env.PRESIGN_3_FILE || path.resolve(__dirname, '..', 'IkaSetups', 'output', 'presign_3_results.json');
const presign3Results: { presignId: string; used?: boolean; [key: string]: any }[] = JSON.parse(fs.readFileSync(PRESIGN_3_FILE, 'utf8'));

const ROOT_SEED_KEY = objectToUint8Array(dWalletData.rootSeedKey);
const testnetIkaCoinType = '0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA';
const senderAddress = "0x854ec4225b6fa32572f50e622147ef6cf3c6eaa390f6b9c100afa3f1ae76291d";

function objectToUint8Array(obj: any): Uint8Array {
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
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const suiClient = new SuiJsonRpcClient({
    url: "https://api.us1.shinami.com/sui/node/v1/us1_sui_testnet_b909eacf46e54e799a307be45791e726",
    network: 'testnet',
  });
  const ikaClient = new IkaClient({
    suiClient: suiClient as any,
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
  const executeTransaction = async (tx: Transaction) => {
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
  const dWalletObjectID = dWalletData.dWalletObjectID;
  // This is the EVM address that corresponds to your Ika dWallet (or the "from" you expect)
  // Wait for DKG to complete
  // Fetch the active dWallet
  const dWallet = await ikaClient.getDWalletInParticularState(
      dWalletObjectID,
      'Active',
      { timeout: 120000, interval: 3000 }
  );
  
  // Get public key from the dWallet's public_output (complete DKG output)
  if (!dWallet.state?.Active?.public_output) {
    throw new Error('dWallet is not in Active state or missing public_output');
  }
  // Convert to Uint8Array if needed
  const dWalletPublicOutput = dWallet.state.Active.public_output instanceof Uint8Array
    ? dWallet.state.Active.public_output
    : new Uint8Array(dWallet.state.Active.public_output);
  console.log("dWalletPublicOutput length:", dWalletPublicOutput.length);
  const publicKey = await publicKeyFromDWalletOutput(
        Curve.SECP256K1,
        dWalletPublicOutput,
  );
  console.log("publicKey length:", publicKey.length);
  console.log("publicKey hex:", ethers.hexlify(publicKey));

  // Convert public key to Ethereum address
  // For secp256k1: need 64-byte uncompressed x,y coordinates (no prefix)
  // - 33 bytes: compressed (02/03 prefix + 32 bytes x) - needs decompression
  // - 64 bytes: uncompressed without prefix (x,y)
  // - 65 bytes: uncompressed with 04 prefix (04 + x,y)
  let uncompressedPubKey: Uint8Array;

  if (publicKey.length === 33) {
    // Compressed public key - decompress using ethers SigningKey
    const decompressed = ethers.SigningKey.computePublicKey(publicKey, false);
    // Returns 65 bytes with 04 prefix, we need 64 bytes without prefix
    uncompressedPubKey = ethers.getBytes(decompressed).slice(1);
    console.log("Decompressed public key (64 bytes):", ethers.hexlify(uncompressedPubKey));
  } else if (publicKey.length === 65) {
    // Uncompressed with 04 prefix - remove prefix
    uncompressedPubKey = publicKey.slice(1);
  } else if (publicKey.length === 64) {
    // Already uncompressed without prefix
    uncompressedPubKey = publicKey;
  } else {
    throw new Error(`Unexpected public key length: ${publicKey.length}`);
  }

  const addressBytes = ethers.getBytes(ethers.keccak256(ethers.hexlify(uncompressedPubKey))).slice(-20);
  const expectedFrom = ethers.getAddress(ethers.hexlify(addressBytes));
  console.log("Ethereum address:", expectedFrom);

  // Helper: sign via Ika and broadcast a single EVM transaction
  async function signAndBroadcast(
    label: string,
    built: { populated: any; unsignedBytes: Uint8Array; digest: string },
    presignId: string,
  ) {
    const { populated, unsignedBytes, digest } = built;
    console.log(`\n=== ${label} ===`);
    console.log("EVM digest to be signed:", digest);
    console.log("Using presignId:", presignId);

    // 1) Create sign request on Ika
    const { execRes, signObjectId } = await ikaSignBytes(
      suiClient,
      ikaClient,
      unsignedBytes,
      executeTransaction,
      signerAddress,
      presignId,
    );

    // 2) Resolve sign object id
    let finalSignObjectId: string;
    if (signObjectId) {
      finalSignObjectId = signObjectId;
    } else {
      const fallbackSignId = execRes.events?.find((event: any) =>
        event.type === 'transferred_object' && event.objectType === 'sign'
      )?.objectId;
      if (!fallbackSignId) {
        throw new Error(`Sign object id not found for ${label}`);
      }
      finalSignObjectId = fallbackSignId;
    }

    // 3) Wait/poll until Completed then fetch signature
    const rawSig = await fetchIkaSignature(ikaClient, finalSignObjectId);

    // 4) Attach signature + send to EVM
    const txHash = await broadcastSignedTx(provider, populated, unsignedBytes, rawSig, expectedFrom);
    console.log(`${label} tx hash:`, txHash);

    // 5) Wait for tx to be mined so nonce increments before next tx
    console.log(`${label} waiting for confirmation...`);
    const receipt = await provider.waitForTransaction(txHash);
    console.log(`${label} confirmed in block ${receipt?.blockNumber}, status: ${receipt?.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    return txHash;
  }

  // Mark a presign as used and persist to disk
  function markPresignUsed(index: number) {
    presign3Results[index]!.used = true;
    fs.writeFileSync(PRESIGN_3_FILE, JSON.stringify(presign3Results, null, 2), 'utf-8');
    console.log(`Presign ${index} marked as used and saved to ${PRESIGN_3_FILE}`);
  }

  // Validate that we have 3 unused presign results
  const unusedCount = presign3Results.filter(p => !p.used).length;
  if (presign3Results.length < 3 || unusedCount < 3) {
    throw new Error(`Expected 3 unused presign results, got ${unusedCount}. Run create_3_Presign_Requests.ts first.`);
  }

  // Log dWallet EVM address balances
  const USDC_ADDR = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
  const usdcContract = new ethers.Contract(USDC_ADDR, ["function balanceOf(address) view returns (uint256)"], provider);
  const [hypeBal, usdcBal] = await Promise.all([
    provider.getBalance(expectedFrom),
    usdcContract.balanceOf!(expectedFrom),
  ]);
  console.log(`\ndWallet EVM address: ${expectedFrom}`);
  console.log(`  HYPE balance: ${ethers.formatEther(hypeBal)} HYPE`);
  console.log(`  USDC balance: ${ethers.formatUnits(usdcBal, 6)} USDC\n`);

  // Deposit amount: 10 USDC (6 decimals) - must exceed Hyperliquid new account fee
  const depositAmount = 10_000_000n;

  // Step 1: Approve USDC spend
  const approveTx = await buildUnsignedApproveUSDC(provider, expectedFrom, depositAmount);
  await signAndBroadcast("Step 1/3: Approve USDC", approveTx, presign3Results[0]!.presignId);
  markPresignUsed(0);

  // Step 2: Deposit USDC to HyperCore (destinationDex=0 for perps)
  const depositTx = await buildUnsignedDeposit(provider, expectedFrom, depositAmount, 0);
  await signAndBroadcast("Step 2/3: Deposit to HyperCore", depositTx, presign3Results[1]!.presignId);
  markPresignUsed(1);

  // Step 3: Place limit order (BTC, buy, $73000, 0.0001 BTC, IOC)
  const orderTx = await buildUnsignedPlaceOrder(
    provider,
    expectedFrom,
    0,        // asset: BTC
    true,     // isBuy
    "73000",  // limitPx
    "0.0001", // sz
    false,    // reduceOnly
    3,        // tif: IOC
  );
  await signAndBroadcast("Step 3/3: Place Order", orderTx, presign3Results[2]!.presignId);
  markPresignUsed(2);

  // === Replace used presigns ===
  console.log('\n[Presign Replacement] Replacing used presign caps...');
  const usedIndices = presign3Results
    .map((entry, idx) => entry.used === true ? idx : -1)
    .filter(idx => idx !== -1);

  if (usedIndices.length === 0) {
    console.log('[Presign Replacement] No used presigns to replace.');
  } else {
    console.log(`[Presign Replacement] Found ${usedIndices.length} used presign(s) to replace.`);

    for (let i = 0; i < usedIndices.length; i++) {
      const idx = usedIndices[i]!;
      const label = `[Replace ${i + 1}/${usedIndices.length} (index ${idx})]`;
      console.log(`\n${label} Creating new presign...`);

      const tx = new Transaction();
      const userShareKeys = await UserShareEncryptionKeys.fromRootSeedKey(ROOT_SEED_KEY, Curve.SECP256K1);
      const ikaTx = new IkaTransaction({
        ikaClient,
        transaction: tx as any,
        userShareEncryptionKeys: userShareKeys,
      });

      const rawUserCoins = await suiClient.getAllCoins({ owner: senderAddress });
      const rawUserIkaCoins = rawUserCoins.data.filter((coin: any) => coin.coinType === testnetIkaCoinType);
      const rawUserSuiCoins = rawUserCoins.data.filter((coin: any) => coin.coinType === '0x2::sui::SUI');
      if (!rawUserIkaCoins[0] || !rawUserSuiCoins[1]) {
        console.error(`${label} Missing required coins, skipping.`);
        continue;
      }
      const userIkaCoin = tx.object(rawUserIkaCoins[0].coinObjectId);
      const dWalletEncryptionKey = await ikaClient.getLatestNetworkEncryptionKey();
      const feeCoin = tx.splitCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [1_000_000]);

      const unverifiedPresignCap = await ikaTx.requestGlobalPresign({
        curve: Curve.SECP256K1,
        signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
        ikaCoin: userIkaCoin,
        suiCoin: feeCoin,
        dwalletNetworkEncryptionKeyId: dWalletEncryptionKey.id,
      });
      tx.mergeCoins(tx.object(rawUserSuiCoins[1].coinObjectId), [feeCoin]);
      tx.transferObjects([unverifiedPresignCap as any], senderAddress);
      tx.setSender(senderAddress);

      console.log(`${label} Executing presign transaction...`);
      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEvents: true },
      });
      const waitResult = await suiClient.waitForTransaction({
        digest: result.digest,
        options: { showEvents: true },
      });

      const presignEvent = waitResult.events?.find(
        (event: any) => event.type.includes('PresignRequestEvent')
      );
      if (!presignEvent) {
        console.error(`${label} PresignRequestEvent not found, skipping.`);
        continue;
      }

      const parsedPresignEvent = SessionsManagerModule.DWalletSessionEvent(
        CoordinatorInnerModule.PresignRequestEvent
      ).fromBase64(presignEvent.bcs as string);
      const presignId = parsedPresignEvent.event_data.presign_id;
      console.log(`${label} Presign ID: ${presignId}`);

      console.log(`${label} Waiting for MPC completion...`);
      let completedPresign: any = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          completedPresign = await ikaClient.getPresignInParticularState(presignId, 'Completed');
          if (completedPresign !== null) break;
        } catch { /* polling */ }
        console.log(`${label} Polling attempt ${attempt + 1}/60...`);
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!completedPresign) {
        console.error(`${label} Presign did not complete in time, skipping.`);
        continue;
      }

      presign3Results[idx] = {
        timestamp: new Date().toISOString(),
        transactionDigest: result.digest,
        presignId,
        presignCapId: completedPresign.cap_id,
        dWalletObjectID,
        curve: 'SECP256K1',
        signatureAlgorithm: 'ECDSASecp256k1',
      };
      fs.writeFileSync(PRESIGN_3_FILE, JSON.stringify(presign3Results, null, 2), 'utf-8');
      console.log(`${label} Replaced and saved.`);

      if (i < usedIndices.length - 1) {
        console.log('[Delay] Waiting 2s before next replacement...');
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log(`\n[Presign Replacement] Done. All used presigns replaced.`);
  }
}

main().catch(console.error);
