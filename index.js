import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { Wallet } from "ethers";
// transport (set isTestnet if you’re testing)
const transport = new HttpTransport({ isTestnet: true });
const wallet = new Wallet(process.env.HL_PRIVATE_KEY);
async function main() {
    const exchange = new ExchangeClient({ wallet, transport });
    await exchange.updateLeverage({ asset: 0, isCross: true, leverage: 5 });
    // place an order (example: limit buy)
    const result = await exchange.order({
        orders: [{
                a: 0, // BTC perp
                b: true, // buy = long
                p: "95000", // limit price
                s: "0.01", // size
                r: false, // reduce_only false => can open/increase
                t: { limit: { tif: "Gtc" } },
            }],
        grouping: "na",
    });
    console.log(result);
}
