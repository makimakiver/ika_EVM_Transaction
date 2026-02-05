import "dotenv/config";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!RPC_URL || !PRIVATE_KEY) throw new Error("Missing env vars");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ✅ Fill these in
const SIMPLE_VALUE = "0x5EbE037801E34031449a06166DeEa2e95393eB53";
const USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
const RECIPIENT = "0xE22b23abd780fB748d41724e4815B6b6954EC481";

// 1 USDC (6 decimals)
const ONE_USDC = 1_000_000n;

const usdcAbi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

const simpleValueAbi = [
  "function transferUSDCFromCaller(address to, uint256 amount) external",
];

async function main() {
  const usdc = new ethers.Contract(USDC, usdcAbi, wallet);
  const simpleValue = new ethers.Contract(SIMPLE_VALUE, simpleValueAbi, wallet);

  // (optional) sanity checks
  const bal = await usdc.balanceOf!(wallet.address);
  console.log("USDC balance:", bal.toString());

  // 1) Approve the contract to spend 1 USDC from your wallet
  const approveTx = await usdc.approve!(SIMPLE_VALUE, ONE_USDC);
  console.log("approve hash:", approveTx.hash);
  await approveTx.wait();

  // 2) Call your contract; it will transferFrom(msg.sender -> recipient)
  const tx = await simpleValue.transferUSDCFromCaller!(RECIPIENT, ONE_USDC);
  console.log("transferUSDCFromCaller hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("status:", receipt.status);
}

main().catch(console.error);
