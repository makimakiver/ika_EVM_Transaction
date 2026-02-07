import { ethers } from "ethers";

// ── Addresses ──────────────────────────────────────────────────────────────
const USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
const CORE_DEPOSIT_WALLET = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206";
const CORE_WRITER = "0x3333333333333333333333333333333333333333";

// ── ABIs ───────────────────────────────────────────────────────────────────
const usdcAbi = ["function approve(address spender, uint256 amount) returns (bool)"];
const coreDepositAbi = ["function deposit(uint256 amount, uint32 destinationDex)"];
const coreWriterAbi = ["function sendRawAction(bytes data) external"];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a decimal string into an integer scaled by 1e8 (no floats).
 * e.g. "94500.25" -> 9450025000000n
 */
function parseFixed8(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
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

// ── Shared builder ─────────────────────────────────────────────────────────

async function buildSingleUnsignedTx(
  provider: ethers.JsonRpcProvider,
  from: string,
  txReq: ethers.TransactionRequest,
  nonceOffset: number = 0,
): Promise<{ populated: any; unsignedBytes: Uint8Array; digest: string }> {
  const nonce = await provider.getTransactionCount(from);
  const fee = await provider.getFeeData();
  const net = await provider.getNetwork();

  const base: any = {
    ...txReq,
    nonce: nonce + nonceOffset,
    chainId: net.chainId,
    type: 2,
    maxFeePerGas: fee.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
  };

  const gasLimit = await provider.estimateGas(base);
  const populated = { ...base, gasLimit };

  const { from: _from, ...txData } = populated;
  const tx = ethers.Transaction.from(txData);
  const unsignedSerialized = tx.unsignedSerialized;
  const unsignedBytes = ethers.getBytes(unsignedSerialized);

  return { populated, unsignedBytes, digest: ethers.keccak256(unsignedBytes) };
}

// ── Public builders ────────────────────────────────────────────────────────

export async function buildUnsignedApproveUSDC(
  provider: ethers.JsonRpcProvider,
  from: string,
  amount: bigint,
) {
  const iface = new ethers.Interface(usdcAbi);
  const data = iface.encodeFunctionData("approve", [CORE_DEPOSIT_WALLET, amount]);

  const txReq: ethers.TransactionRequest = { from, to: USDC, data, value: 0n };
  return buildSingleUnsignedTx(provider, from, txReq);
}

export async function buildUnsignedDeposit(
  provider: ethers.JsonRpcProvider,
  from: string,
  amount: bigint,
  destinationDex: number = 0,
) {
  const iface = new ethers.Interface(coreDepositAbi);
  const data = iface.encodeFunctionData("deposit", [amount, destinationDex]);

  const txReq: ethers.TransactionRequest = { from, to: CORE_DEPOSIT_WALLET, data, value: 0n };
  return buildSingleUnsignedTx(provider, from, txReq);
}

export async function buildUnsignedPlaceOrder(
  provider: ethers.JsonRpcProvider,
  from: string,
  asset: number,
  isBuy: boolean,
  limitPx: string,
  sz: string,
  reduceOnly: boolean = false,
  tif: number = 3,
  cloid: bigint = 0n,
) {
  const ACTION_ID_LIMIT_ORDER = 1;

  const limitPxScaled = parseFixed8(limitPx);
  const szScaled = parseFixed8(sz);

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodedAction = coder.encode(
    ["uint32", "bool", "uint64", "uint64", "bool", "uint8", "uint128"],
    [asset, isBuy, limitPxScaled, szScaled, reduceOnly, tif, cloid],
  );

  const actionData = encodeCoreWriterAction(ACTION_ID_LIMIT_ORDER, encodedAction);

  const iface = new ethers.Interface(coreWriterAbi);
  const data = iface.encodeFunctionData("sendRawAction", [actionData]);

  const txReq: ethers.TransactionRequest = { from, to: CORE_WRITER, data, value: 0n };
  return buildSingleUnsignedTx(provider, from, txReq);
}
