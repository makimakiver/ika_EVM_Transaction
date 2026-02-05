import { ethers } from "ethers";

const CONTRACT = "0xC9C39De3261A43d7999718975fDC49aC75B65814";
const abi = ["function setValue(uint256 newValue)"];

export async function buildUnsignedSetValueTx(
  provider: ethers.JsonRpcProvider,
  from: string,
  newValue: number
) {
  console.log("from: ", from);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData("setValue", [newValue]);
  console.log("data: ", data);
  // Let provider fill nonce/fees/chainId/gasLimit
  const txReq: ethers.TransactionRequest = { from, to: CONTRACT, data, value: 0n };
  console.log("txReq: ", txReq);
  const populated = await provider.getTransactionCount(from).then(async (nonce) => {
    const fee = await provider.getFeeData();
    const net = await provider.getNetwork();

    // EIP-1559 style (if your chain supports it)
    const base: any = {
      ...txReq,
      nonce,
      chainId: net.chainId,
      type: 2,
      maxFeePerGas: fee.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
    };

    // estimate gas
    const gasLimit = await provider.estimateGas(base);
    return { ...base, gasLimit };
  });
  console.log("populated: ", populated);
  // Remove 'from' field for unsigned transaction (unsigned transactions cannot have 'from')
  const { from: _from, ...txData } = populated;
  const tx = ethers.Transaction.from(txData);
  console.log("tx: ", tx);
  const unsignedSerialized = tx.unsignedSerialized;            // hex string
  const unsignedBytes = ethers.getBytes(unsignedSerialized);   // Uint8Array

  return { populated, unsignedBytes, digest: ethers.keccak256(unsignedBytes) };
}
