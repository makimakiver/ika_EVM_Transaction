import { Curve, IkaClient, SignatureAlgorithm } from "@ika.xyz/sdk";
declare const ikaClient: IkaClient;
export async function fetchIkaSignature(ikaClient: IkaClient, signObjectId: string) {
  console.log("[Debug] Fetching sign object:", signObjectId);
  const sign = await ikaClient.getSignInParticularState(
    signObjectId,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
    "Completed",
  );

  console.log("[Debug] Sign state:", sign.state?.$kind);
  console.log("[Debug] Sign object full:", JSON.stringify(sign, (key, value) =>
    value instanceof Uint8Array ? `Uint8Array(${value.length}): ${Buffer.from(value).toString('hex').slice(0, 64)}...` : value, 2
  ));

  const rawSignature = Uint8Array.from(sign.state.Completed.signature);
  console.log("[Debug] Raw signature length:", rawSignature.length);
  return rawSignature; // typically 65 bytes (r||s||v) or 64 bytes (r||s)
}
