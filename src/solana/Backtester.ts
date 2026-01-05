import Big from "big.js"
import { Service } from "typedi"
import { Log } from "../Log"
import { TokenInfo, LIQUID_TOKENS } from "./MarketDataService"

export interface HistoricalCandle {
    timestamp: number
    open: Big
    high: Big
    low: Big
    close: Big
    volume: Big
}

export interface BacktestTrade {
    timestamp: number
    token: TokenInfo
    side: "BUY" | "SELL"
    entryPrice: Big
    exitPrice: Big
    size: Big
    pnl: Big
    pnlPercent: Big
    holdingPeriod: number // in candles
}

export interface BacktestResult {
    startDate: Date
    endDate: Date
    initialCapital: Big
    finalCapital: Big
    totalReturn: Big
    totalReturnPercent: Big
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: Big
    avgWin: Big
    avgLoss: Big
    profitFactor: Big
    maxDrawdown: Big
    maxDrawdownPercent: Big
    sharpeRatio: Big
    trades: BacktestTrade[]
}

export interface BacktestConfig {
    initialCapital: number
    positionSizePercent: number
    takeProfitPercent: number
    stopLossPercent: number
    slippagePercent: number
    tradingFeePercent: number
}

@Service()
export class Backtester {
    private readonly log = Log.getLogger(Backtester.name)
    private priceHistory: Map<string, HistoricalCandle[]> = new Map()

    // Generate synthetic price data for backtesting
    generateSyntheticData(
        token: TokenInfo,
        days: number,
        intervalMinutes: number = 5,
        basePrice: number = 100,
        volatility: number = 0.02
    ): HistoricalCandle[] {
        const candles: HistoricalCandle[] = []
        const candlesPerDay = (24 * 60) / intervalMinutes
        const totalCandles = days * candlesPerDay

        let price = Big(basePrice)
        const now = Date.now()
        const startTime = now - days * 24 * 60 * 60 * 1000

        for (let i = 0; i < totalCandles; i++) {
            const timestamp = startTime + i * intervalMinutes * 60 * 1000

            // Random walk with mean reversion
            const randomReturn = (Math.random() - 0.5) * 2 * volatility
            const meanReversion = (Big(basePrice).sub(price)).div(basePrice).mul(0.01)
            const priceChange = price.mul(randomReturn).add(price.mul(meanReversion))

            const open = price
            price = price.add(priceChange)
            const close = price

            // Generate high/low with some noise
            const range = price.mul(volatility * 0.5)
            const high = (open.gt(close) ? open : close).add(range.mul(Math.random()))
            const low = (open.lt(close) ? open : close).sub(range.mul(Math.random()))

            // Random volume
            const volume = Big(1000000).mul(0.5 + Math.random())

            candles.push({ timestamp, open, high, low, close, volume })
        }

        this.priceHistory.set(token.mint.toBase58(), candles)
        return candles
    }

    // Load historical data (can be extended to fetch from APIs)
    loadHistoricalData(token: TokenInfo, candles: HistoricalCandle[]): void {
        this.priceHistory.set(token.mint.toBase58(), candles)
    }

    // Calculate technical indicators
    private calculateSMA(prices: Big[], period: number): Big | null {
        if (prices.length < period) return null
        const slice = prices.slice(-period)
        return slice.reduce((a, b) => a.add(b), Big(0)).div(period)
    }

    private calculateRSI(prices: Big[], period: number = 14): Big | null {
        if (prices.length < period + 1) return null

        const changes: Big[] = []
        for (let i = prices.length - period; i < prices.length; i++) {
            changes.push(prices[i].sub(prices[i - 1]))
        }

        let gains = Big(0)
        let losses = Big(0)

        for (const change of changes) {
            if (change.gt(0)) gains = gains.add(change)
            else losses = losses.add(change.abs())
        }

        if (losses.eq(0)) return Big(100)

        const avgGain = gains.div(period)
        const avgLoss = losses.div(period)
        const rs = avgGain.div(avgLoss)

        return Big(100).sub(Big(100).div(Big(1).add(rs)))
    }

    private calculateVolatility(prices: Big[], period: number = 20): Big | null {
        if (prices.length < period) return null

        const slice = prices.slice(-period)
        const mean = slice.reduce((a, b) => a.add(b), Big(0)).div(period)
        const squaredDiffs = slice.map(p => p.sub(mean).pow(2))
        const variance = squaredDiffs.reduce((a, b) => a.add(b), Big(0)).div(period)

        return variance.sqrt().div(mean).mul(100)
    }

    // Generate trading signal
    private generateSignal(
        prices: Big[],
        index: number
    ): { signal: "BUY" | "SELL" | "HOLD"; confidence: number } {
        const lookback = prices.slice(0, index + 1)
        if (lookback.length < 30) return { signal: "HOLD", confidence: 0 }

        const sma5 = this.calculateSMA(lookback, 5)
        const sma20 = this.calculateSMA(lookback, 20)
        const rsi = this.calculateRSI(lookback, 14)
        const volatility = this.calculateVolatility(lookback, 20)

        if (!sma5 || !sma20 || !rsi || !volatility) {
            return { signal: "HOLD", confidence: 0 }
        }

        const trendStrength = sma5.sub(sma20).div(sma20).mul(100)

        // RSI oversold - BUY signal
        if (rsi.lt(30) && trendStrength.gt(-2)) {
            const confidence = Math.min(0.8, (30 - Number(rsi.toString())) / 30)
            return { signal: "BUY", confidence }
        }

        // RSI overbought - SELL signal (close longs)
        if (rsi.gt(70) && trendStrength.lt(2)) {
            const confidence = Math.min(0.8, (Number(rsi.toString()) - 70) / 30)
            return { signal: "SELL", confidence }
        }

        // Momentum breakout
        if (volatility.lt(2) && trendStrength.gt(0.5)) {
            return { signal: "BUY", confidence: 0.6 }
        }

        return { signal: "HOLD", confidence: 0 }
    }

    // Run backtest
    async runBacktest(
        token: TokenInfo,
        config: BacktestConfig
    ): Promise<BacktestResult> {
        const candles = this.priceHistory.get(token.mint.toBase58())
        if (!candles || candles.length < 50) {
            throw new Error("Insufficient historical data for backtesting")
        }

        const trades: BacktestTrade[] = []
        let capital = Big(config.initialCapital)
        let position: { entryPrice: Big; size: Big; entryIndex: number } | null = null
        let maxCapital = capital
        let maxDrawdown = Big(0)

        const prices = candles.map(c => c.close)

        for (let i = 30; i < candles.length; i++) {
            const candle = candles[i]
            const currentPrice = candle.close

            // Check existing position
            if (position) {
                const pnlPercent = currentPrice.sub(position.entryPrice).div(position.entryPrice).mul(100)

                // Take profit
                if (pnlPercent.gte(config.takeProfitPercent)) {
                    const exitPrice = currentPrice.mul(1 - config.slippagePercent / 100)
                    const grossPnl = position.size.mul(exitPrice.sub(position.entryPrice).div(position.entryPrice))
                    const fee = position.size.mul(config.tradingFeePercent / 100)
                    const netPnl = grossPnl.sub(fee)

                    capital = capital.add(netPnl)
                    trades.push({
                        timestamp: candle.timestamp,
                        token,
                        side: "SELL",
                        entryPrice: position.entryPrice,
                        exitPrice,
                        size: position.size,
                        pnl: netPnl,
                        pnlPercent: netPnl.div(position.size).mul(100),
                        holdingPeriod: i - position.entryIndex,
                    })
                    position = null
                }
                // Stop loss
                else if (pnlPercent.lte(-config.stopLossPercent)) {
                    const exitPrice = currentPrice.mul(1 - config.slippagePercent / 100)
                    const grossPnl = position.size.mul(exitPrice.sub(position.entryPrice).div(position.entryPrice))
                    const fee = position.size.mul(config.tradingFeePercent / 100)
                    const netPnl = grossPnl.sub(fee)

                    capital = capital.add(netPnl)
                    trades.push({
                        timestamp: candle.timestamp,
                        token,
                        side: "SELL",
                        entryPrice: position.entryPrice,
                        exitPrice,
                        size: position.size,
                        pnl: netPnl,
                        pnlPercent: netPnl.div(position.size).mul(100),
                        holdingPeriod: i - position.entryIndex,
                    })
                    position = null
                }
            }

            // Generate signal for new position
            if (!position) {
                const { signal, confidence } = this.generateSignal(prices, i)

                if (signal === "BUY" && confidence >= 0.6) {
                    const positionSize = capital.mul(config.positionSizePercent / 100)
                    const entryPrice = currentPrice.mul(1 + config.slippagePercent / 100)
                    const fee = positionSize.mul(config.tradingFeePercent / 100)

                    capital = capital.sub(fee)
                    position = {
                        entryPrice,
                        size: positionSize,
                        entryIndex: i,
                    }
                }
            }

            // Track drawdown
            if (capital.gt(maxCapital)) {
                maxCapital = capital
            }
            const currentDrawdown = maxCapital.sub(capital).div(maxCapital).mul(100)
            if (currentDrawdown.gt(maxDrawdown)) {
                maxDrawdown = currentDrawdown
            }
        }

        // Close any remaining position at last price
        if (position) {
            const lastCandle = candles[candles.length - 1]
            const exitPrice = lastCandle.close.mul(1 - config.slippagePercent / 100)
            const grossPnl = position.size.mul(exitPrice.sub(position.entryPrice).div(position.entryPrice))
            const fee = position.size.mul(config.tradingFeePercent / 100)
            const netPnl = grossPnl.sub(fee)

            capital = capital.add(netPnl)
            trades.push({
                timestamp: lastCandle.timestamp,
                token,
                side: "SELL",
                entryPrice: position.entryPrice,
                exitPrice,
                size: position.size,
                pnl: netPnl,
                pnlPercent: netPnl.div(position.size).mul(100),
                holdingPeriod: candles.length - 1 - position.entryIndex,
            })
        }

        // Calculate statistics
        const winningTrades = trades.filter(t => t.pnl.gt(0))
        const losingTrades = trades.filter(t => t.pnl.lte(0))

        const totalWins = winningTrades.reduce((a, t) => a.add(t.pnl), Big(0))
        const totalLosses = losingTrades.reduce((a, t) => a.add(t.pnl.abs()), Big(0))

        const avgWin = winningTrades.length > 0
            ? totalWins.div(winningTrades.length)
            : Big(0)
        const avgLoss = losingTrades.length > 0
            ? totalLosses.div(losingTrades.length)
            : Big(0)

        const profitFactor = totalLosses.gt(0)
            ? totalWins.div(totalLosses)
            : Big(999)

        // Simplified Sharpe Ratio (assuming risk-free rate = 0)
        const returns = trades.map(t => Number(t.pnlPercent.toString()))
        const avgReturn = returns.length > 0
            ? returns.reduce((a, b) => a + b, 0) / returns.length
            : 0
        const stdDev = returns.length > 1
            ? Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
            : 1
        const sharpeRatio = stdDev > 0 ? Big(avgReturn / stdDev) : Big(0)

        return {
            startDate: new Date(candles[0].timestamp),
            endDate: new Date(candles[candles.length - 1].timestamp),
            initialCapital: Big(config.initialCapital),
            finalCapital: capital,
            totalReturn: capital.sub(config.initialCapital),
            totalReturnPercent: capital.sub(config.initialCapital).div(config.initialCapital).mul(100),
            totalTrades: trades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: trades.length > 0 ? Big(winningTrades.length).div(trades.length).mul(100) : Big(0),
            avgWin,
            avgLoss,
            profitFactor,
            maxDrawdown,
            maxDrawdownPercent: maxDrawdown,
            sharpeRatio,
            trades,
        }
    }

    // Print backtest report
    printReport(result: BacktestResult): void {
        console.log("\n" + "=".repeat(60))
        console.log("                    BACKTEST REPORT")
        console.log("=".repeat(60))
        console.log(`Period: ${result.startDate.toISOString().split("T")[0]} to ${result.endDate.toISOString().split("T")[0]}`)
        console.log("-".repeat(60))
        console.log(`Initial Capital:     $${result.initialCapital.toFixed(2)}`)
        console.log(`Final Capital:       $${result.finalCapital.toFixed(2)}`)
        console.log(`Total Return:        $${result.totalReturn.toFixed(2)} (${result.totalReturnPercent.toFixed(2)}%)`)
        console.log("-".repeat(60))
        console.log(`Total Trades:        ${result.totalTrades}`)
        console.log(`Winning Trades:      ${result.winningTrades} (${result.winRate.toFixed(1)}%)`)
        console.log(`Losing Trades:       ${result.losingTrades}`)
        console.log(`Average Win:         $${result.avgWin.toFixed(2)}`)
        console.log(`Average Loss:        $${result.avgLoss.toFixed(2)}`)
        console.log(`Profit Factor:       ${result.profitFactor.toFixed(2)}`)
        console.log("-".repeat(60))
        console.log(`Max Drawdown:        ${result.maxDrawdownPercent.toFixed(2)}%`)
        console.log(`Sharpe Ratio:        ${result.sharpeRatio.toFixed(2)}`)
        console.log("=".repeat(60) + "\n")
    }
}

// Helper function to get max of two Big values
function BigMax(a: Big, b: Big): Big {
    return a.gt(b) ? a : b
}

function BigMin(a: Big, b: Big): Big {
    return a.lt(b) ? a : b
}

// Extend Big with static max/min
const Big_max = (a: Big, b: Big) => a.gt(b) ? a : b
const Big_min = (a: Big, b: Big) => a.lt(b) ? a : b

// Re-export for use
;(Big as any).max = Big_max
;(Big as any).min = Big_min
