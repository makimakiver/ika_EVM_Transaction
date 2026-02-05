import { ethers } from "ethers";

async function resolveAddress(addr: ethers.AddressLike): Promise<string> {
  if (typeof addr === "string") {
    return ethers.getAddress(addr);
  }
  if (addr instanceof Promise) {
    return ethers.getAddress(await addr);
  }
  return ethers.getAddress(await addr.getAddress());
}

function splitRSV(raw: Uint8Array) {
  if (raw.length === 65) {
    const r = ethers.hexlify(raw.slice(0, 32));
    const s = ethers.hexlify(raw.slice(32, 64));
    const v0 = raw[64]!; // Safe: we checked length === 65
    const v = v0 >= 27 ? v0 : (v0 + 27);
    return { r, s, v };
  }
  if (raw.length === 64) {
    const r = ethers.hexlify(raw.slice(0, 32));
    const s = ethers.hexlify(raw.slice(32, 64));
    return { r, s, v: undefined as number | undefined };
  }
  throw new Error(`Unexpected signature length: ${raw.length}`);
}

export async function broadcastSignedTx(
  provider: ethers.JsonRpcProvider,
  populatedTx: ethers.TransactionRequest,
  unsignedBytes: Uint8Array,
  rawSig: Uint8Array,
  expectedFrom?: string,
) {
  console.log("[Debug] rawSig length:", rawSig.length);
  console.log("[Debug] rawSig hex:", ethers.hexlify(rawSig));
  console.log("[Debug] unsignedBytes length:", unsignedBytes.length);
  console.log("[Debug] unsignedBytes hex:", ethers.hexlify(unsignedBytes));

  const digest = ethers.keccak256(unsignedBytes);
  let { r, s, v } = splitRSV(rawSig);

  // If v not supplied, guess 27/28 by recovery
  if (v === undefined) {
    console.log("[Debug] Signature r:", r);
    console.log("[Debug] Signature s:", s);
    console.log("[Debug] Digest:", digest);
    console.log("[Debug] Expected from:", expectedFrom);

    for (const cand of [27, 28]) {
      try {
        const recovered = ethers.recoverAddress(digest, { r, s, v: cand });
        console.log(`[Debug] v=${cand} recovers to: ${recovered}`);
        if (!expectedFrom || recovered.toLowerCase() === expectedFrom.toLowerCase()) {
          v = cand;
          break;
        }
      } catch (err) {
        console.log(`[Debug] v=${cand} recovery failed:`, err);
      }
    }
    if (v === undefined) throw new Error("Could not determine v");
  }

  // Resolve any promise-based address fields and build transaction data
  const txData: ethers.TransactionLike = {
    signature: { r, s, v },
  };
  
  if (populatedTx.to) {
    txData.to = await resolveAddress(populatedTx.to);
  }
  if (populatedTx.from) {
    txData.from = await resolveAddress(populatedTx.from);
  }
  if (populatedTx.nonce != null) txData.nonce = populatedTx.nonce;
  if (populatedTx.gasLimit != null) txData.gasLimit = populatedTx.gasLimit;
  if (populatedTx.gasPrice != null) txData.gasPrice = populatedTx.gasPrice;
  if (populatedTx.data != null) txData.data = populatedTx.data;
  if (populatedTx.value != null) txData.value = populatedTx.value;
  if (populatedTx.chainId != null) txData.chainId = populatedTx.chainId;
  if (populatedTx.type != null) txData.type = populatedTx.type;
  if (populatedTx.accessList != null) txData.accessList = populatedTx.accessList;
  if (populatedTx.maxFeePerGas != null) txData.maxFeePerGas = populatedTx.maxFeePerGas;
  if (populatedTx.maxPriorityFeePerGas != null) txData.maxPriorityFeePerGas = populatedTx.maxPriorityFeePerGas;
  
  const signed = ethers.Transaction.from(txData);
  return await provider.send('eth_sendRawTransaction', [signed.serialized]);
}
