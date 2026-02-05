import { writeFile } from "node:fs/promises";
async function main() {
    const url = "https://api.hyperliquid.xyz/info";
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
    }
    const meta = (await res.json());
    if (!meta || !Array.isArray(meta.universe)) {
        throw new Error(`Unexpected response shape: ${JSON.stringify(meta).slice(0, 500)}`);
    }
    // Asset index = array index in meta.universe
    const assets = meta.universe.map((u, i) => ({
        asset: i,
        name: u.name,
        // Include a couple optional fields if present (nice for debugging)
        szDecimals: u.szDecimals,
        maxLeverage: u.maxLeverage,
        onlyIsolated: u.onlyIsolated,
    }));
    await writeFile("./AssetsIdx/assets.json", JSON.stringify(assets, null, 2));
    // Pretty print
    console.log(JSON.stringify(assets, null, 2));
    // Example: find HYPE if it exists
    const hype = assets.find((a) => a.name === "BTC");
    if (hype) {
        console.error(`\nFound HYPE asset index: ${hype.asset}`);
    }
    else {
        console.error(`\nHYPE not found in meta.universe (maybe not listed as a perp).`);
    }
}
main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
