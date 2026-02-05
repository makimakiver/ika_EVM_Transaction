import "dotenv/config";
import { ethers } from "ethers";
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
// Pick the right addresses for your network:
const USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab"; // HyperEVM testnet USDC
const CORE_DEPOSIT_WALLET = "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206"; // testnet CoreDepositWallet

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!RPC_URL || !PRIVATE_KEY) throw new Error("Missing env vars");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Minimal ABIs
const usdcAbi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
];

const coreDepositAbi = [
  "function deposit(uint256 amount, uint32 destinationDex)",
  "function depositFor(address recipient, uint256 amount, uint32 destinationDex)",
];

async function main() {
  const usdc = new ethers.Contract(USDC, usdcAbi, wallet);
  const core = new ethers.Contract(CORE_DEPOSIT_WALLET, coreDepositAbi, wallet);

  // 1 USDC (6 decimals)
  const amount = 1_000_000n;

  // Choose destination:
  const DEST_PERPS = 0; // perps
  // const DEST_SPOT = 4294967295; // spot (uint32.max)

  console.log("From:", wallet.address);
  console.log("USDC balance:", (await usdc.balanceOf!(wallet.address)).toString());

  // 1) Approve CoreDepositWallet to pull USDC (only needed if allowance < amount)
  const currentAllowance: bigint = await usdc.allowance!(wallet.address, CORE_DEPOSIT_WALLET);
  if (currentAllowance < amount) {
    const approveTx = await usdc.approve!(CORE_DEPOSIT_WALLET, amount);
    console.log("approve tx:", approveTx.hash);
    await approveTx.wait();
  }

  // 2) Deposit to HyperCore
  const depTx = await core.deposit!(amount, DEST_PERPS);
  console.log("deposit tx:", depTx.hash);
  const receipt = await depTx.wait();
  console.log("status:", receipt?.status);
}

main().catch(console.error);
