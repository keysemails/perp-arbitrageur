import Big from "big.js"
import { Service } from "typedi"
import { Log } from "../Log"
import { SolanaService } from "./SolanaService"
import { JupiterService } from "./JupiterService"
import { MarketDataService } from "./MarketDataService"
import { TradingStrategy } from "./TradingStrategy"
import { RiskManager } from "./RiskManager"
import { BotConfig } from "./config"

@Service()
export class SolanaBot {
    private readonly log = Log.getLogger(SolanaBot.name)
    private solanaService: SolanaService
    private jupiterService: JupiterService
    private marketDataService: MarketDataService
    private tradingStrategy: TradingStrategy
    private riskManager: RiskManager

    private config!: BotConfig
    private isRunning: boolean = false
    private intervalId: NodeJS.Timeout | null = null
    private cycleCount: number = 0

    constructor(
        solanaService: SolanaService,
        jupiterService: JupiterService,
        marketDataService: MarketDataService,
        tradingStrategy: TradingStrategy,
        riskManager: RiskManager
    ) {
        this.solanaService = solanaService
        this.jupiterService = jupiterService
        this.marketDataService = marketDataService
        this.tradingStrategy = tradingStrategy
        this.riskManager = riskManager
    }

    async init(config: BotConfig): Promise<void> {
        this.config = config

        // Initialize all services
        await this.solanaService.init(config.rpcEndpoint, config.privateKey)
        this.jupiterService.init(this.solanaService, config.slippageBps)
        this.marketDataService.init(this.jupiterService, config.priceHistoryLength)
        this.tradingStrategy.init(
            this.solanaService,
            this.jupiterService,
            this.marketDataService
        )
        this.riskManager.init(this.solanaService, this.tradingStrategy)

        // Set initial capital
        this.riskManager.setLimits({
            initialCapital: Big(config.initialCapital),
            maxDrawdownPercent: config.maxDrawdownPercent,
            maxDailyLossPercent: config.maxDailyLossPercent,
        })

        // Configure strategy
        this.tradingStrategy.setParameters({
            maxPositions: config.maxPositions,
            positionSizePercent: config.positionSizePercent,
            takeProfitPercent: config.takeProfitPercent,
            stopLossPercent: config.stopLossPercent,
            minTradeSize: config.minTradeSize,
        })

        this.log.info({
            event: "SolanaBotInitialized",
            wallet: this.solanaService.getPublicKey().toBase58(),
            initialCapital: config.initialCapital,
        })

        // Perform initial health check
        const healthy = await this.solanaService.healthCheck()
        if (!healthy) {
            throw new Error("Solana service health check failed")
        }

        // Log initial balances
        const solBalance = await this.solanaService.getSolBalance()
        const usdcBalance = await this.solanaService.getUsdcBalance()

        this.log.info({
            event: "InitialBalances",
            SOL: solBalance.toString(),
            USDC: usdcBalance.toString(),
        })
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            this.log.warn({ event: "BotAlreadyRunning" })
            return
        }

        this.isRunning = true
        this.log.info({
            event: "BotStarted",
            intervalMs: this.config.intervalMs,
        })

        // Run immediately
        await this.runCycle()

        // Start interval
        this.intervalId = setInterval(async () => {
            if (this.isRunning) {
                await this.runCycle()
            }
        }, this.config.intervalMs)
    }

    async stop(): Promise<void> {
        this.isRunning = false
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        this.log.info({ event: "BotStopped" })
    }

    private async runCycle(): Promise<void> {
        this.cycleCount++

        try {
            this.log.debug({
                event: "CycleStart",
                cycle: this.cycleCount,
            })

            // 1. Fetch latest prices
            await this.marketDataService.fetchPrices()

            // 2. Check risk limits
            const riskStatus = await this.riskManager.checkRisk()
            if (!riskStatus.isTradeAllowed) {
                this.log.debug({
                    event: "TradingBlocked",
                    reason: riskStatus.reason,
                })
                // Still manage existing positions
                await this.tradingStrategy.checkAndManagePositions()
                return
            }

            // 3. Manage existing positions (check stop loss / take profit)
            await this.tradingStrategy.checkAndManagePositions()

            // 4. Look for new high-probability signals
            const signals = await this.marketDataService.getHighProbabilitySignals()

            // 5. Execute best signal if available
            if (signals.length > 0) {
                const availableCapital = this.riskManager.getAvailableCapital()

                for (const signal of signals) {
                    if (availableCapital.lt(this.config.minTradeSize)) {
                        break
                    }

                    const position = await this.tradingStrategy.executeSignal(
                        signal,
                        availableCapital
                    )

                    if (position) {
                        // Record trade for risk tracking
                        // PnL will be recorded when position closes
                        break // Only one trade per cycle
                    }
                }
            }

            // 6. Log stats periodically (every 10 cycles)
            if (this.cycleCount % 10 === 0) {
                await this.logStats()
            }
        } catch (e) {
            this.log.error({
                event: "CycleError",
                cycle: this.cycleCount,
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    private async logStats(): Promise<void> {
        const stats = this.tradingStrategy.getStats()
        const riskStatus = await this.riskManager.checkRisk()
        const positions = this.tradingStrategy.getOpenPositions()

        this.log.info({
            event: "BotStats",
            cycle: this.cycleCount,
            currentCapital: riskStatus.currentCapital.toString(),
            netPnl: stats.netPnl.toString(),
            drawdownPercent: riskStatus.drawdownPercent.toFixed(2),
            totalTrades: stats.totalTrades,
            winRate: (stats.winRate * 100).toFixed(1) + "%",
            volume: stats.volume.toString(),
            openPositions: positions.length,
            positions: positions.map((p) => ({
                token: p.token.symbol,
                entryPrice: p.entryPrice.toString(),
                usdcSpent: p.usdcSpent.toString(),
            })),
        })
    }

    async getStatus(): Promise<{
        isRunning: boolean
        cycleCount: number
        stats: any
        riskStatus: any
        positions: any[]
    }> {
        const stats = this.tradingStrategy.getStats()
        const riskStatus = await this.riskManager.checkRisk()
        const positions = this.tradingStrategy.getOpenPositions()

        return {
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            stats: {
                totalTrades: stats.totalTrades,
                winningTrades: stats.winningTrades,
                losingTrades: stats.losingTrades,
                winRate: stats.winRate,
                netPnl: stats.netPnl.toString(),
                volume: stats.volume.toString(),
                maxDrawdown: stats.maxDrawdown.toString(),
            },
            riskStatus: {
                currentCapital: riskStatus.currentCapital.toString(),
                totalPnl: riskStatus.totalPnl.toString(),
                drawdownPercent: riskStatus.drawdownPercent,
                dailyPnl: riskStatus.dailyPnl.toString(),
                tradesThisHour: riskStatus.tradesThisHour,
                isTradeAllowed: riskStatus.isTradeAllowed,
                reason: riskStatus.reason,
            },
            positions: positions.map((p) => ({
                id: p.id,
                token: p.token.symbol,
                entryPrice: p.entryPrice.toString(),
                entryAmount: p.entryAmount.toString(),
                usdcSpent: p.usdcSpent.toString(),
                targetPrice: p.targetPrice.toString(),
                stopLoss: p.stopLoss.toString(),
                timestamp: p.timestamp,
            })),
        }
    }

    pause(): void {
        this.riskManager.pause()
    }

    resume(): void {
        this.riskManager.resume()
    }

    async emergencyStop(): Promise<void> {
        await this.stop()
        await this.riskManager.emergencyStop()
        this.log.error({ event: "EmergencyStopExecuted" })
    }
}
