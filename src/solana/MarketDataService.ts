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

    // MACD (Moving Average Convergence Divergence)
    calculateMACD(mint: PublicKey): { macd: Big; signal: Big; histogram: Big } | null {
        const ema12 = this.calculateEMA(mint, 12)
        const ema26 = this.calculateEMA(mint, 26)

        if (!ema12 || !ema26) return null

        const macd = ema12.sub(ema26)

        // Signal line (9-period EMA of MACD) - simplified calculation
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < 35) return null

        // Calculate MACD values for signal line
        const macdValues: Big[] = []
        for (let i = 26; i < history.prices.length; i++) {
            const slice = history.prices.slice(0, i + 1)
            const e12 = this.calculateEMAFromPrices(slice, 12)
            const e26 = this.calculateEMAFromPrices(slice, 26)
            if (e12 && e26) macdValues.push(e12.sub(e26))
        }

        if (macdValues.length < 9) return null

        const signalMultiplier = Big(2).div(10)
        let signal = macdValues.slice(0, 9).reduce((a, b) => a.add(b), Big(0)).div(9)
        for (let i = 9; i < macdValues.length; i++) {
            signal = macdValues[i].mul(signalMultiplier).add(signal.mul(Big(1).sub(signalMultiplier)))
        }

        const histogram = macd.sub(signal)

        return { macd, signal, histogram }
    }

    private calculateEMAFromPrices(prices: Big[], periods: number): Big | null {
        if (prices.length < periods) return null

        const multiplier = Big(2).div(periods + 1)
        let ema = prices.slice(0, periods).reduce((a, b) => a.add(b), Big(0)).div(periods)

        for (let i = periods; i < prices.length; i++) {
            ema = prices[i].mul(multiplier).add(ema.mul(Big(1).sub(multiplier)))
        }

        return ema
    }

    // Bollinger Bands
    calculateBollingerBands(mint: PublicKey, periods: number = 20, stdDev: number = 2): {
        upper: Big
        middle: Big
        lower: Big
        percentB: Big
    } | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods) return null

        const recentPrices = history.prices.slice(-periods)
        const middle = recentPrices.reduce((a, b) => a.add(b), Big(0)).div(periods)

        const squaredDiffs = recentPrices.map(p => p.sub(middle).pow(2))
        const variance = squaredDiffs.reduce((a, b) => a.add(b), Big(0)).div(periods)
        const std = variance.sqrt()

        const upper = middle.add(std.mul(stdDev))
        const lower = middle.sub(std.mul(stdDev))

        const currentPrice = recentPrices[recentPrices.length - 1]
        const percentB = upper.sub(lower).eq(0)
            ? Big(0.5)
            : currentPrice.sub(lower).div(upper.sub(lower))

        return { upper, middle, lower, percentB }
    }

    // Momentum indicator
    calculateMomentum(mint: PublicKey, periods: number = 10): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods + 1) return null

        const currentPrice = history.prices[history.prices.length - 1]
        const pastPrice = history.prices[history.prices.length - periods - 1]

        return currentPrice.sub(pastPrice).div(pastPrice).mul(100)
    }

    // Stochastic Oscillator
    calculateStochastic(mint: PublicKey, periods: number = 14): { k: Big; d: Big } | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods + 3) return null

        const recentPrices = history.prices.slice(-periods)
        const currentPrice = recentPrices[recentPrices.length - 1]

        let highest = recentPrices[0]
        let lowest = recentPrices[0]
        for (const price of recentPrices) {
            if (price.gt(highest)) highest = price
            if (price.lt(lowest)) lowest = price
        }

        const range = highest.sub(lowest)
        const k = range.eq(0) ? Big(50) : currentPrice.sub(lowest).div(range).mul(100)

        // %D is 3-period SMA of %K (simplified - just return K as D for now)
        const d = k

        return { k, d }
    }

    // Average True Range (ATR) for volatility
    calculateATR(mint: PublicKey, periods: number = 14): Big | null {
        const history = this.priceHistories.get(mint.toBase58())
        if (!history || history.prices.length < periods + 1) return null

        const prices = history.prices.slice(-(periods + 1))
        const trueRanges: Big[] = []

        for (let i = 1; i < prices.length; i++) {
            const high = prices[i] // Simplified - using close as proxy
            const low = prices[i].mul(0.995) // Assume 0.5% daily range
            const prevClose = prices[i - 1]

            const tr1 = high.sub(low)
            const tr2 = high.sub(prevClose).abs()
            const tr3 = low.sub(prevClose).abs()

            const tr = tr1.gt(tr2) ? (tr1.gt(tr3) ? tr1 : tr3) : (tr2.gt(tr3) ? tr2 : tr3)
            trueRanges.push(tr)
        }

        return trueRanges.reduce((a, b) => a.add(b), Big(0)).div(trueRanges.length)
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
        const macd = this.calculateMACD(token.mint)
        const bollinger = this.calculateBollingerBands(token.mint, 20)
        const stochastic = this.calculateStochastic(token.mint)
        const momentum = this.calculateMomentum(token.mint, 10)

        let signal: "BUY" | "SELL" | "HOLD" = "HOLD"
        let confidence = 0
        let reason = ""
        let signals: { type: string; weight: number }[] = []

        // Multi-indicator analysis for high probability
        if (sma5 && sma20 && rsi && volatility) {
            const trendStrength = sma5.sub(sma20).div(sma20).mul(100)

            // RSI Signal (weight: 0.25)
            if (rsi.lt(30)) {
                signals.push({ type: "BUY", weight: 0.25 * (30 - Number(rsi.toString())) / 30 })
            } else if (rsi.gt(70)) {
                signals.push({ type: "SELL", weight: 0.25 * (Number(rsi.toString()) - 70) / 30 })
            }

            // MACD Signal (weight: 0.2)
            if (macd) {
                if (macd.histogram.gt(0) && macd.macd.gt(0)) {
                    signals.push({ type: "BUY", weight: 0.2 })
                } else if (macd.histogram.lt(0) && macd.macd.lt(0)) {
                    signals.push({ type: "SELL", weight: 0.2 })
                }
            }

            // Bollinger Bands Signal (weight: 0.2)
            if (bollinger) {
                if (bollinger.percentB.lt(0.1)) { // Near lower band
                    signals.push({ type: "BUY", weight: 0.2 * (1 - Number(bollinger.percentB.toString()) * 2) })
                } else if (bollinger.percentB.gt(0.9)) { // Near upper band
                    signals.push({ type: "SELL", weight: 0.2 * (Number(bollinger.percentB.toString()) - 0.5) * 2 })
                }
            }

            // Stochastic Signal (weight: 0.15)
            if (stochastic) {
                if (stochastic.k.lt(20)) {
                    signals.push({ type: "BUY", weight: 0.15 })
                } else if (stochastic.k.gt(80)) {
                    signals.push({ type: "SELL", weight: 0.15 })
                }
            }

            // Momentum Signal (weight: 0.1)
            if (momentum) {
                if (momentum.gt(1) && trendStrength.gt(0)) {
                    signals.push({ type: "BUY", weight: 0.1 })
                } else if (momentum.lt(-1) && trendStrength.lt(0)) {
                    signals.push({ type: "SELL", weight: 0.1 })
                }
            }

            // Trend confirmation (weight: 0.1)
            if (volatility.lt(3)) { // Low volatility = clearer signals
                if (trendStrength.gt(0.5)) {
                    signals.push({ type: "BUY", weight: 0.1 })
                } else if (trendStrength.lt(-0.5)) {
                    signals.push({ type: "SELL", weight: 0.1 })
                }
            }

            // Calculate net signal
            let buyWeight = signals.filter(s => s.type === "BUY").reduce((a, s) => a + s.weight, 0)
            let sellWeight = signals.filter(s => s.type === "SELL").reduce((a, s) => a + s.weight, 0)

            if (buyWeight > sellWeight && buyWeight > 0.5) {
                signal = "BUY"
                confidence = Math.min(0.9, buyWeight)
                reason = `Multi-indicator BUY: RSI=${rsi.toFixed(0)}, MACD=${macd?.histogram.gt(0) ? "+" : "-"}, BB%=${bollinger?.percentB.toFixed(2) || "N/A"}`
            } else if (sellWeight > buyWeight && sellWeight > 0.5) {
                signal = "SELL"
                confidence = Math.min(0.9, sellWeight)
                reason = `Multi-indicator SELL: RSI=${rsi.toFixed(0)}, MACD=${macd?.histogram.lt(0) ? "-" : "+"}, BB%=${bollinger?.percentB.toFixed(2) || "N/A"}`
            }
        }

        // Only high probability trades (confidence > 0.6)
        if (confidence < 0.6) {
            signal = "HOLD"
            reason = "Insufficient signal strength for high-probability trade"
        }

        // Calculate target and stop loss based on volatility
        const atr = this.calculateATR(token.mint, 14)
        const atrMultiplier = atr ? Number(atr.div(currentPrice).mul(100).toString()) : 0.5

        const targetMultiplier = signal === "BUY"
            ? 1 + Math.max(0.5, atrMultiplier * 1.5) / 100
            : 1 - Math.max(0.5, atrMultiplier * 1.5) / 100
        const stopMultiplier = signal === "BUY"
            ? 1 - Math.max(0.3, atrMultiplier) / 100
            : 1 + Math.max(0.3, atrMultiplier) / 100

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
