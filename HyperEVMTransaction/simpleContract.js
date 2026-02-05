import "dotenv/config";
import { ethers } from "ethers";
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY)
    throw new Error("Missing env vars");
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const CONTRACT = "0xC9C39De3261A43d7999718975fDC49aC75B65814";
const abi = [
    "function setValue(uint256 newValue)",
    "function value() view returns (uint256)",
];
const c = new ethers.Contract(CONTRACT, abi, wallet);
async function main() {
    console.log("Sender:", wallet.address);
    console.log("Current:", (await c.value()).toString());
    const tx = await c.setValue(123);
    console.log("Tx hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Status:", receipt?.status);
}
main().catch(console.error);
