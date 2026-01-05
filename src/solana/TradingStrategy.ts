import { PublicKey } from "@solana/web3.js"
import Big from "big.js"
import { Service } from "typedi"
import { Log } from "../Log"
import { JupiterService, SwapResult } from "./JupiterService"
import { MarketDataService, MarketSignal, TokenInfo } from "./MarketDataService"
import { SolanaService, USDC_MINT, USDC_DECIMALS } from "./SolanaService"

export interface Position {
    id: string
    token: TokenInfo
    entryPrice: Big
    entryAmount: Big
    usdcSpent: Big
    targetPrice: Big
    stopLoss: Big
    timestamp: number
    status: "OPEN" | "CLOSED"
    exitPrice?: Big
    exitAmount?: Big
    pnl?: Big
}

export interface TradeStats {
    totalTrades: number
    winningTrades: number
    losingTrades: number
    totalProfit: Big
    totalLoss: Big
    netPnl: Big
    winRate: number
    avgProfit: Big
    avgLoss: Big
    maxDrawdown: Big
    volume: Big
}

@Service()
export class TradingStrategy {
    private readonly log = Log.getLogger(TradingStrategy.name)
    private solanaService!: SolanaService
    private jupiterService!: JupiterService
    private marketDataService!: MarketDataService

    private positions: Map<string, Position> = new Map()
    private closedPositions: Position[] = []
    private stats: TradeStats = {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: Big(0),
        totalLoss: Big(0),
        netPnl: Big(0),
        winRate: 0,
        avgProfit: Big(0),
        avgLoss: Big(0),
        maxDrawdown: Big(0),
        volume: Big(0),
    }

    // Strategy parameters for high-volume, low-profit scalping
    private maxPositions: number = 3
    private positionSizePercent: number = 0.3 // 30% of capital per trade
    private minTradeSize: Big = Big(5) // Minimum $5 per trade
    private takeProfitPercent: number = 0.5 // 0.5% take profit
    private stopLossPercent: number = 0.3 // 0.3% stop loss
    private maxSlippageBps: number = 50 // 0.5% max slippage

    init(
        solanaService: SolanaService,
        jupiterService: JupiterService,
        marketDataService: MarketDataService
    ): void {
        this.solanaService = solanaService
        this.jupiterService = jupiterService
        this.marketDataService = marketDataService

        this.log.info({
            event: "TradingStrategyInitialized",
            maxPositions: this.maxPositions,
            positionSizePercent: this.positionSizePercent,
            takeProfitPercent: this.takeProfitPercent,
            stopLossPercent: this.stopLossPercent,
        })
    }

    async executeSignal(
        signal: MarketSignal,
        availableCapital: Big
    ): Promise<Position | null> {
        if (signal.signal === "HOLD") return null

        const positionSize = availableCapital.mul(this.positionSizePercent)
        if (positionSize.lt(this.minTradeSize)) {
            this.log.warn({
                event: "InsufficientCapital",
                available: availableCapital.toString(),
                minimum: this.minTradeSize.toString(),
            })
            return null
        }

        // Check max positions
        if (this.positions.size >= this.maxPositions) {
            this.log.debug({
                event: "MaxPositionsReached",
                current: this.positions.size,
                max: this.maxPositions,
            })
            return null
        }

        // Check if we already have a position in this token
        const existingPosition = Array.from(this.positions.values()).find(
            (p) => p.token.mint.equals(signal.token.mint)
        )
        if (existingPosition) {
            this.log.debug({
                event: "PositionExists",
                token: signal.token.symbol,
            })
            return null
        }

        if (signal.signal === "BUY") {
            return this.openLongPosition(signal, positionSize)
        }

        return null // For now, only long positions (no shorting on spot)
    }

    private async openLongPosition(
        signal: MarketSignal,
        usdcAmount: Big
    ): Promise<Position | null> {
        this.log.info({
            event: "OpeningLongPosition",
            token: signal.token.symbol,
            amount: usdcAmount.toString(),
            confidence: signal.confidence,
            reason: signal.reason,
        })

        // Get quote first
        const quote = await this.jupiterService.getQuote(
            USDC_MINT,
            signal.token.mint,
            usdcAmount,
            USDC_DECIMALS,
            this.maxSlippageBps
        )

        if (!quote) {
            this.log.warn({
                event: "QuoteFailed",
                token: signal.token.symbol,
            })
            return null
        }

        // Check price impact
        const priceImpact = Big(quote.priceImpactPct)
        if (priceImpact.abs().gt(0.5)) {
            this.log.warn({
                event: "HighPriceImpact",
                token: signal.token.symbol,
                impact: priceImpact.toString(),
            })
            return null
        }

        // Execute swap
        const result = await this.jupiterService.executeSwap(quote)
        if (!result) {
            this.log.error({
                event: "SwapFailed",
                token: signal.token.symbol,
            })
            return null
        }

        const position: Position = {
            id: `${signal.token.symbol}-${Date.now()}`,
            token: signal.token,
            entryPrice: signal.currentPrice,
            entryAmount: result.outputAmount,
            usdcSpent: result.inputAmount,
            targetPrice: signal.currentPrice.mul(1 + this.takeProfitPercent / 100),
            stopLoss: signal.currentPrice.mul(1 - this.stopLossPercent / 100),
            timestamp: Date.now(),
            status: "OPEN",
        }

        this.positions.set(position.id, position)
        this.stats.volume = this.stats.volume.add(result.inputAmount)

        this.log.info({
            event: "PositionOpened",
            id: position.id,
            token: signal.token.symbol,
            entryPrice: position.entryPrice.toString(),
            amount: position.entryAmount.toString(),
            usdcSpent: position.usdcSpent.toString(),
            targetPrice: position.targetPrice.toString(),
            stopLoss: position.stopLoss.toString(),
            signature: result.signature,
        })

        return position
    }

    async checkAndManagePositions(): Promise<void> {
        for (const [id, position] of this.positions) {
            const priceData = this.marketDataService.getLastPrice(position.token.mint)
            if (!priceData) continue

            const currentPrice = priceData.price
            const pnlPercent = currentPrice
                .sub(position.entryPrice)
                .div(position.entryPrice)
                .mul(100)

            this.log.debug({
                event: "PositionCheck",
                id: position.id,
                token: position.token.symbol,
                entryPrice: position.entryPrice.toString(),
                currentPrice: currentPrice.toString(),
                pnlPercent: pnlPercent.toString(),
            })

            // Check take profit
            if (currentPrice.gte(position.targetPrice)) {
                await this.closePosition(position, currentPrice, "TAKE_PROFIT")
            }
            // Check stop loss
            else if (currentPrice.lte(position.stopLoss)) {
                await this.closePosition(position, currentPrice, "STOP_LOSS")
            }
            // Trailing stop for profitable positions (adjust stop loss up)
            else if (pnlPercent.gt(0.3)) {
                const newStopLoss = currentPrice.mul(1 - this.stopLossPercent / 100)
                if (newStopLoss.gt(position.stopLoss)) {
                    position.stopLoss = newStopLoss
                    this.log.debug({
                        event: "TrailingStopAdjusted",
                        id: position.id,
                        newStopLoss: newStopLoss.toString(),
                    })
                }
            }
        }
    }

    private async closePosition(
        position: Position,
        currentPrice: Big,
        reason: string
    ): Promise<void> {
        this.log.info({
            event: "ClosingPosition",
            id: position.id,
            token: position.token.symbol,
            reason,
            currentPrice: currentPrice.toString(),
        })

        // Execute sell swap
        const quote = await this.jupiterService.getQuote(
            position.token.mint,
            USDC_MINT,
            position.entryAmount,
            position.token.decimals,
            this.maxSlippageBps
        )

        if (!quote) {
            this.log.error({
                event: "CloseQuoteFailed",
                id: position.id,
            })
            return
        }

        const result = await this.jupiterService.executeSwap(quote)
        if (!result) {
            this.log.error({
                event: "CloseSwapFailed",
                id: position.id,
            })
            return
        }

        // Calculate PnL
        const pnl = result.outputAmount.sub(position.usdcSpent)

        position.status = "CLOSED"
        position.exitPrice = currentPrice
        position.exitAmount = result.outputAmount
        position.pnl = pnl

        // Update stats
        this.stats.totalTrades++
        this.stats.volume = this.stats.volume.add(result.outputAmount)

        if (pnl.gt(0)) {
            this.stats.winningTrades++
            this.stats.totalProfit = this.stats.totalProfit.add(pnl)
        } else {
            this.stats.losingTrades++
            this.stats.totalLoss = this.stats.totalLoss.add(pnl.abs())
        }

        this.stats.netPnl = this.stats.totalProfit.sub(this.stats.totalLoss)
        this.stats.winRate =
            this.stats.totalTrades > 0
                ? this.stats.winningTrades / this.stats.totalTrades
                : 0
        this.stats.avgProfit =
            this.stats.winningTrades > 0
                ? this.stats.totalProfit.div(this.stats.winningTrades)
                : Big(0)
        this.stats.avgLoss =
            this.stats.losingTrades > 0
                ? this.stats.totalLoss.div(this.stats.losingTrades)
                : Big(0)

        // Track max drawdown
        if (this.stats.netPnl.lt(this.stats.maxDrawdown)) {
            this.stats.maxDrawdown = this.stats.netPnl
        }

        // Move to closed positions
        this.closedPositions.push(position)
        this.positions.delete(position.id)

        this.log.info({
            event: "PositionClosed",
            id: position.id,
            token: position.token.symbol,
            reason,
            entryPrice: position.entryPrice.toString(),
            exitPrice: position.exitPrice.toString(),
            usdcSpent: position.usdcSpent.toString(),
            usdcReceived: result.outputAmount.toString(),
            pnl: pnl.toString(),
            signature: result.signature,
        })
    }

    getOpenPositions(): Position[] {
        return Array.from(this.positions.values())
    }

    getClosedPositions(): Position[] {
        return this.closedPositions
    }

    getStats(): TradeStats {
        return { ...this.stats }
    }

    getPositionValue(): Big {
        let totalValue = Big(0)
        for (const position of this.positions.values()) {
            const priceData = this.marketDataService.getLastPrice(position.token.mint)
            if (priceData) {
                totalValue = totalValue.add(position.entryAmount.mul(priceData.price))
            }
        }
        return totalValue
    }

    // Emergency close all positions
    async closeAllPositions(): Promise<void> {
        for (const position of this.positions.values()) {
            const priceData = this.marketDataService.getLastPrice(position.token.mint)
            if (priceData) {
                await this.closePosition(position, priceData.price, "EMERGENCY_CLOSE")
            }
        }
    }

    setParameters(params: {
        maxPositions?: number
        positionSizePercent?: number
        takeProfitPercent?: number
        stopLossPercent?: number
        minTradeSize?: number
    }): void {
        if (params.maxPositions !== undefined)
            this.maxPositions = params.maxPositions
        if (params.positionSizePercent !== undefined)
            this.positionSizePercent = params.positionSizePercent
        if (params.takeProfitPercent !== undefined)
            this.takeProfitPercent = params.takeProfitPercent
        if (params.stopLossPercent !== undefined)
            this.stopLossPercent = params.stopLossPercent
        if (params.minTradeSize !== undefined)
            this.minTradeSize = Big(params.minTradeSize)

        this.log.info({
            event: "ParametersUpdated",
            maxPositions: this.maxPositions,
            positionSizePercent: this.positionSizePercent,
            takeProfitPercent: this.takeProfitPercent,
            stopLossPercent: this.stopLossPercent,
            minTradeSize: this.minTradeSize.toString(),
        })
    }
}
