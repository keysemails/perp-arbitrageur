import { PublicKey } from "@solana/web3.js"
import Big from "big.js"
import fetch from "node-fetch"
import { Service } from "typedi"
import { Log } from "../Log"
import { JupiterService } from "./JupiterService"
import { USDC_MINT, USDC_DECIMALS } from "./SolanaService"

const JUPITER_PRICE_API = "https://price.jup.ag/v6/price"

export interface TokenInfo {
    mint: PublicKey
    symbol: string
    decimals: number
}

export interface PriceData {
    token: TokenInfo
    price: Big
    timestamp: number
}

export interface PriceHistory {
    prices: Big[]
    timestamps: number[]
    maxLength: number
}

export interface MarketSignal {
    token: TokenInfo
    signal: "BUY" | "SELL" | "HOLD"
    confidence: number // 0-1
    currentPrice: Big
    targetPrice: Big
    stopLoss: Big
    reason: string
}

// Liquid Solana tokens for high-volume trading
export const LIQUID_TOKENS: TokenInfo[] = [
    {
        mint: new PublicKey("So11111111111111111111111111111111111111112"),
        symbol: "SOL",
        decimals: 9,
    },
    {
        mint: new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
        symbol: "mSOL",
        decimals: 9,
    },
    {
        mint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
        symbol: "JitoSOL",
        decimals: 9,
    },
    {
        mint: new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
        symbol: "bSOL",
        decimals: 9,
    },
    {
        mint: new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
        symbol: "JUP",
        decimals: 6,
    },
]

@Service()
export class MarketDataService {
    private readonly log = Log.getLogger(MarketDataService.name)
    private jupiterService!: JupiterService
    private priceHistories: Map<string, PriceHistory> = new Map()
    private historyLength: number = 60 // Keep 60 price points
    private lastPrices: Map<string, PriceData> = new Map()

    init(jupiterService: JupiterService, historyLength?: number): void {
        this.jupiterService = jupiterService
        if (historyLength) {
            this.historyLength = historyLength
        }

        // Initialize price histories for all tokens
        for (const token of LIQUID_TOKENS) {
            this.priceHistories.set(token.mint.toBase58(), {
                prices: [],
                timestamps: [],
                maxLength: this.historyLength,
            })
        }

        this.log.info({
            event: "MarketDataServiceInitialized",
            trackedTokens: LIQUID_TOKENS.map((t) => t.symbol),
            historyLength: this.historyLength,
        })
    }

    async fetchPrices(): Promise<Map<string, PriceData>> {
        const results = new Map<string, PriceData>()
        const now = Date.now()

        try {
            // Fetch prices from Jupiter Price API (faster than quotes)
            const ids = LIQUID_TOKENS.map((t) => t.mint.toBase58()).join(",")
            const response = await fetch(`${JUPITER_PRICE_API}?ids=${ids}`)

            if (response.ok) {
                const data = (await response.json()) as {
                    data: Record<string, { price: number }>
                }

                for (const token of LIQUID_TOKENS) {
                    const mintStr = token.mint.toBase58()
                    const priceInfo = data.data[mintStr]

                    if (priceInfo) {
                        const priceData: PriceData = {
                            token,
                            price: Big(priceInfo.price),
                            timestamp: now,
                        }

                        results.set(mintStr, priceData)
                        this.lastPrices.set(mintStr, priceData)
                        this.updatePriceHistory(mintStr, priceData.price, now)
                    }
                }
            }
        } catch (e) {
            this.log.error({
                event: "FetchPricesError",
                error: e instanceof Error ? e.message : String(e),
            })
        }

        return results
    }

    private updatePriceHistory(mint: string, price: Big, timestamp: number): void {
        const history = this.priceHistories.get(mint)
        if (!history) return

        history.prices.push(price)
        history.timestamps.push(timestamp)

        // Keep only the most recent entries
        while (history.prices.length > history.maxLength) {
            history.prices.shift()
            history.timestamps.shift()
        }
    }

    getLastPrice(mint: PublicKey): PriceData | null {
        return this.lastPrices.get(mint.toBase58()) ?? null
    }

    getPriceHistory(mint: PublicKey): PriceHistory | null {
        return this.priceHistories.get(mint.toBase58()) ?? null
    }

    calculateSMA(mint: PublicKey, periods: number): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods) return null

        const recentPrices = history.prices.slice(-periods)
        const sum = recentPrices.reduce((acc, p) => acc.add(p), Big(0))
        return sum.div(periods)
    }

    calculateEMA(mint: PublicKey, periods: number): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods) return null

        const multiplier = Big(2).div(periods + 1)
        let ema = this.calculateSMA(mint, periods)!

        const recentPrices = history.prices.slice(-periods)
        for (let i = 1; i < recentPrices.length; i++) {
            ema = recentPrices[i].mul(multiplier).add(ema.mul(Big(1).sub(multiplier)))
        }

        return ema
    }

    calculateRSI(mint: PublicKey, periods: number = 14): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods + 1) return null

        const recentPrices = history.prices.slice(-(periods + 1))
        let gains = Big(0)
        let losses = Big(0)

        for (let i = 1; i < recentPrices.length; i++) {
            const change = recentPrices[i].sub(recentPrices[i - 1])
            if (change.gt(0)) {
                gains = gains.add(change)
            } else {
                losses = losses.add(change.abs())
            }
        }

        if (losses.eq(0)) return Big(100)

        const avgGain = gains.div(periods)
        const avgLoss = losses.div(periods)
        const rs = avgGain.div(avgLoss)
        const rsi = Big(100).sub(Big(100).div(Big(1).add(rs)))

        return rsi
    }

    calculateVolatility(mint: PublicKey, periods: number = 20): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods) return null

        const recentPrices = history.prices.slice(-periods)
        const mean = recentPrices.reduce((a, b) => a.add(b), Big(0)).div(periods)

        const squaredDiffs = recentPrices.map((p) => p.sub(mean).pow(2))
        const variance = squaredDiffs.reduce((a, b) => a.add(b), Big(0)).div(periods)

        // Standard deviation as percentage of mean
        return variance.sqrt().div(mean).mul(100)
    }

    async analyzeMarket(token: TokenInfo): Promise<MarketSignal> {
        const mintStr = token.mint.toBase58()
        const lastPrice = this.lastPrices.get(mintStr)

        if (!lastPrice) {
            return {
                token,
                signal: "HOLD",
                confidence: 0,
                currentPrice: Big(0),
                targetPrice: Big(0),
                stopLoss: Big(0),
                reason: "No price data available",
            }
        }

        const currentPrice = lastPrice.price
        const sma5 = this.calculateSMA(token.mint, 5)
        const sma20 = this.calculateSMA(token.mint, 20)
        const rsi = this.calculateRSI(token.mint, 14)
        const volatility = this.calculateVolatility(token.mint, 20)

        let signal: "BUY" | "SELL" | "HOLD" = "HOLD"
        let confidence = 0
        let reason = ""

        // High probability conditions for scalping
        if (sma5 && sma20 && rsi && volatility) {
            const trendStrength = sma5.sub(sma20).div(sma20).mul(100)

            // Mean reversion strategy for oversold/overbought conditions
            if (rsi.lt(30) && trendStrength.gt(-2)) {
                signal = "BUY"
                confidence = Math.min(0.8, (30 - Number(rsi.toString())) / 30)
                reason = `RSI oversold at ${rsi.toFixed(1)}, potential bounce`
            } else if (rsi.gt(70) && trendStrength.lt(2)) {
                signal = "SELL"
                confidence = Math.min(0.8, (Number(rsi.toString()) - 70) / 30)
                reason = `RSI overbought at ${rsi.toFixed(1)}, potential pullback`
            }
            // Momentum breakout with low volatility
            else if (volatility.lt(2) && trendStrength.gt(0.5)) {
                signal = "BUY"
                confidence = 0.6
                reason = `Low volatility breakout, trend strength ${trendStrength.toFixed(2)}%`
            } else if (volatility.lt(2) && trendStrength.lt(-0.5)) {
                signal = "SELL"
                confidence = 0.6
                reason = `Low volatility breakdown, trend strength ${trendStrength.toFixed(2)}%`
            }
        }

        // Only high probability trades (confidence > 0.6)
        if (confidence < 0.6) {
            signal = "HOLD"
            reason = "Conditions not favorable for high-probability trade"
        }

        // Calculate target and stop loss for scalping (tight ranges)
        const targetMultiplier = signal === "BUY" ? 1.005 : 0.995 // 0.5% target
        const stopMultiplier = signal === "BUY" ? 0.997 : 1.003 // 0.3% stop loss

        return {
            token,
            signal,
            confidence,
            currentPrice,
            targetPrice: currentPrice.mul(targetMultiplier),
            stopLoss: currentPrice.mul(stopMultiplier),
            reason,
        }
    }

    async getHighProbabilitySignals(): Promise<MarketSignal[]> {
        const signals: MarketSignal[] = []

        for (const token of LIQUID_TOKENS) {
            const signal = await this.analyzeMarket(token)
            if (signal.signal !== "HOLD" && signal.confidence >= 0.6) {
                signals.push(signal)
            }
        }

        // Sort by confidence (highest first)
        signals.sort((a, b) => b.confidence - a.confidence)

        return signals
    }
}
