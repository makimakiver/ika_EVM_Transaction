import "dotenv/config";
import { ethers } from "ethers";
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!RPC_URL || !PRIVATE_KEY) throw new Error("Missing env vars");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// CoreWriter system contract
const CORE_WRITER = "0x3333333333333333333333333333333333333333";

// Minimal ABI (CoreWriter.sol exposes sendRawAction(bytes))
const coreWriterAbi = ["function sendRawAction(bytes data) external"];
const coreWriter = new ethers.Contract(CORE_WRITER, coreWriterAbi, wallet);

/**
 * Parse a decimal string into an integer scaled by 1e8 (no floats).
 * e.g. "94500.25" -> 9450025000000n
 */
function parseFixed8(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8); // pad/right-trim to 8
  const sign = whole?.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole?.replace("-", "");
  return sign * (BigInt(wholeAbs || "0") * 100000000n + BigInt(fracPadded || "0"));
}

/**
 * Encode CoreWriter action bytes:
 * version (1 byte) + actionId (3 bytes BE) + abi.encode(fields)
 */
function encodeCoreWriterAction(actionId: number, encodedAction: string): string {
  if (actionId < 0 || actionId > 0xffffff) throw new Error("actionId out of range (0..0xffffff)");

  const header = new Uint8Array(4);
  header[0] = 0x01; // encoding version
  header[1] = (actionId >> 16) & 0xff;
  header[2] = (actionId >> 8) & 0xff;
  header[3] = actionId & 0xff;

  return ethers.hexlify(header) + encodedAction.slice(2);
}

async function main() {
  console.log("Sender:", wallet.address);

  // --- Order params ---
  const ACTION_ID_LIMIT_ORDER = 1; // :contentReference[oaicite:5]{index=5}

  // IMPORTANT: "asset" is a uint32 market id used by HyperCore.
  // You must supply the correct asset id for the coin/perp you want.
  const asset: number = 0; // example only

  const isBuy = true;        // true=buy/long, false=sell/short
  const reduceOnly = false;  // false to open/increase position
  const tif = 3;             // 1=Alo, 2=Gtc, 3=Ioc :contentReference[oaicite:6]{index=6}
  const cloid = 0n;          // 0 = no cloid :contentReference[oaicite:7]{index=7}

  // limitPx and sz must be uint64 and scaled by 1e8 :contentReference[oaicite:8]{index=8}
  const limitPx = parseFixed8("73000"); // $95,000.00000000 -> scaled integer
  const sz = parseFixed8("0.0001");       // size in coin units -> scaled integer

  // --- ABI-encode the action fields (solidity types from docs) ---
  // (uint32, bool, uint64, uint64, bool, uint8, uint128) :contentReference[oaicite:9]{index=9}
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodedAction = coder.encode(
    ["uint32", "bool", "uint64", "uint64", "bool", "uint8", "uint128"],
    [asset, isBuy, limitPx, sz, reduceOnly, tif, cloid]
  );

  // --- Build the final CoreWriter payload bytes ---
  const data = encodeCoreWriterAction(ACTION_ID_LIMIT_ORDER, encodedAction);

  // --- Send on-chain ---
  const tx = await coreWriter.sendRawAction!(data);
  console.log("CoreWriter tx hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("status:", receipt.status);
}

main().catch(console.error);
