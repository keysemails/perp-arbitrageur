import Big from "big.js"
import { Container, Service } from "typedi"
import { Log } from "../Log"
import { SolanaService } from "./SolanaService"
import { JupiterService } from "./JupiterService"
import { MarketDataService } from "./MarketDataService"
import { TradingStrategy } from "./TradingStrategy"
import { RiskManager } from "./RiskManager"
import { FlashLoanService, ArbitrageOpportunity } from "./FlashLoanService"
import { Backtester, BacktestConfig, BacktestResult } from "./Backtester"
import { LIQUID_TOKENS } from "./MarketDataService"
import { BotConfig } from "./config"

export interface SelfFundingConfig extends BotConfig {
    // Flash loan settings
    enableFlashLoans: boolean
    minFlashLoanProfit: number // Minimum profit % to execute
    maxFlashLoanSize: number   // Max borrow amount in USDC
    flashLoanIntervalMs: number // How often to scan for arbitrage

    // Profit reinvestment
    profitReinvestPercent: number // % of profits to reinvest
    profitReservePercent: number  // % of profits to keep as reserve

    // Bootstrap mode (start with $0)
    bootstrapMode: boolean
    targetBootstrapCapital: number // Target capital before switching to regular trading
}

export interface BotStats {
    mode: "BOOTSTRAP" | "TRADING" | "HYBRID"
    totalCapital: Big
    flashLoanProfit: Big
    tradingProfit: Big
    totalProfit: Big
    arbitrageExecuted: number
    tradesExecuted: number
    uptime: number // seconds
    startTime: number
}

@Service()
export class SelfFundingBot {
    private readonly log = Log.getLogger(SelfFundingBot.name)

    private solanaService: SolanaService
    private jupiterService: JupiterService
    private marketDataService: MarketDataService
    private tradingStrategy: TradingStrategy
    private riskManager: RiskManager
    private flashLoanService: FlashLoanService
    private backtester: Backtester

    private config!: SelfFundingConfig
    private isRunning: boolean = false
    private flashLoanIntervalId: NodeJS.Timeout | null = null
    private tradingIntervalId: NodeJS.Timeout | null = null

    private stats: BotStats = {
        mode: "BOOTSTRAP",
        totalCapital: Big(0),
        flashLoanProfit: Big(0),
        tradingProfit: Big(0),
        totalProfit: Big(0),
        arbitrageExecuted: 0,
        tradesExecuted: 0,
        uptime: 0,
        startTime: 0,
    }

    constructor(
        solanaService: SolanaService,
        jupiterService: JupiterService,
        marketDataService: MarketDataService,
        tradingStrategy: TradingStrategy,
        riskManager: RiskManager,
        flashLoanService: FlashLoanService,
        backtester: Backtester
    ) {
        this.solanaService = solanaService
        this.jupiterService = jupiterService
        this.marketDataService = marketDataService
        this.tradingStrategy = tradingStrategy
        this.riskManager = riskManager
        this.flashLoanService = flashLoanService
        this.backtester = backtester
    }

    async init(config: SelfFundingConfig): Promise<void> {
        this.config = config

        // Initialize core services
        await this.solanaService.init(config.rpcEndpoint, config.privateKey)
        this.jupiterService.init(this.solanaService, config.slippageBps)
        this.marketDataService.init(this.jupiterService, config.priceHistoryLength)
        this.tradingStrategy.init(
            this.solanaService,
            this.jupiterService,
            this.marketDataService
        )
        this.riskManager.init(this.solanaService, this.tradingStrategy)
        this.flashLoanService.init(this.solanaService, this.jupiterService)

        // Configure flash loan service
        this.flashLoanService.setMinProfitThreshold(config.minFlashLoanProfit)
        this.flashLoanService.setMaxBorrowAmount(Big(config.maxFlashLoanSize))

        // Check initial capital
        const usdcBalance = await this.solanaService.getUsdcBalance()
        this.stats.totalCapital = usdcBalance
        this.stats.startTime = Date.now()

        // Determine starting mode
        if (config.bootstrapMode && usdcBalance.lt(config.targetBootstrapCapital)) {
            this.stats.mode = "BOOTSTRAP"
            this.log.info({
                event: "StartingInBootstrapMode",
                currentCapital: usdcBalance.toString(),
                targetCapital: config.targetBootstrapCapital,
            })
        } else if (config.enableFlashLoans) {
            this.stats.mode = "HYBRID"
        } else {
            this.stats.mode = "TRADING"
        }

        this.log.info({
            event: "SelfFundingBotInitialized",
            mode: this.stats.mode,
            wallet: this.solanaService.getPublicKey().toBase58(),
            initialCapital: usdcBalance.toString(),
            bootstrapMode: config.bootstrapMode,
            flashLoansEnabled: config.enableFlashLoans,
        })
    }

    // Run backtest before starting live trading
    async runBacktest(days: number = 30): Promise<BacktestResult[]> {
        this.log.info({
            event: "RunningBacktest",
            days,
            tokens: LIQUID_TOKENS.map(t => t.symbol),
        })

        const results: BacktestResult[] = []
        const backtestConfig: BacktestConfig = {
            initialCapital: Number(this.config.initialCapital),
            positionSizePercent: this.config.positionSizePercent,
            takeProfitPercent: this.config.takeProfitPercent,
            stopLossPercent: this.config.stopLossPercent,
            slippagePercent: 0.1,
            tradingFeePercent: 0.1,
        }

        for (const token of LIQUID_TOKENS) {
            // Generate synthetic data (in production, fetch real historical data)
            const basePrice = token.symbol === "SOL" ? 100 :
                             token.symbol === "JUP" ? 1 : 100
            this.backtester.generateSyntheticData(
                token,
                days,
                5, // 5-minute candles
                basePrice,
                0.03 // 3% daily volatility
            )

            const result = await this.backtester.runBacktest(token, backtestConfig)
            results.push(result)
            this.backtester.printReport(result)
        }

        // Summary
        const totalReturn = results.reduce(
            (acc, r) => acc.add(r.totalReturnPercent),
            Big(0)
        ).div(results.length)

        const avgWinRate = results.reduce(
            (acc, r) => acc.add(r.winRate),
            Big(0)
        ).div(results.length)

        this.log.info({
            event: "BacktestSummary",
            averageReturn: totalReturn.toFixed(2) + "%",
            averageWinRate: avgWinRate.toFixed(1) + "%",
            totalTrades: results.reduce((a, r) => a + r.totalTrades, 0),
        })

        return results
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            this.log.warn({ event: "BotAlreadyRunning" })
            return
        }

        this.isRunning = true
        this.log.info({ event: "SelfFundingBotStarted", mode: this.stats.mode })

        // Start flash loan arbitrage scanner
        if (this.config.enableFlashLoans || this.stats.mode === "BOOTSTRAP") {
            await this.runFlashLoanCycle()
            this.flashLoanIntervalId = setInterval(
                () => this.runFlashLoanCycle(),
                this.config.flashLoanIntervalMs
            )
        }

        // Start regular trading (if we have capital)
        if (this.stats.mode !== "BOOTSTRAP") {
            await this.runTradingCycle()
            this.tradingIntervalId = setInterval(
                () => this.runTradingCycle(),
                this.config.intervalMs
            )
        }
    }

    async stop(): Promise<void> {
        this.isRunning = false
        if (this.flashLoanIntervalId) {
            clearInterval(this.flashLoanIntervalId)
            this.flashLoanIntervalId = null
        }
        if (this.tradingIntervalId) {
            clearInterval(this.tradingIntervalId)
            this.tradingIntervalId = null
        }
        this.log.info({ event: "SelfFundingBotStopped" })
    }

    private async runFlashLoanCycle(): Promise<void> {
        try {
            this.log.debug({ event: "FlashLoanCycleStart" })

            const result = await this.flashLoanService.runSelfFundingCycle()

            if (result.executed > 0) {
                this.stats.flashLoanProfit = this.stats.flashLoanProfit.add(result.totalProfit)
                this.stats.totalProfit = this.stats.totalProfit.add(result.totalProfit)
                this.stats.arbitrageExecuted += result.executed

                // Update capital
                const newBalance = await this.solanaService.getUsdcBalance()
                this.stats.totalCapital = newBalance

                this.log.info({
                    event: "FlashLoanCycleComplete",
                    opportunitiesFound: result.opportunities,
                    executed: result.executed,
                    cycleProfit: result.totalProfit.toString(),
                    totalFlashLoanProfit: this.stats.flashLoanProfit.toString(),
                    currentCapital: newBalance.toString(),
                })

                // Check if we've bootstrapped enough capital
                if (this.stats.mode === "BOOTSTRAP") {
                    if (newBalance.gte(this.config.targetBootstrapCapital)) {
                        this.log.info({
                            event: "BootstrapComplete",
                            capital: newBalance.toString(),
                            target: this.config.targetBootstrapCapital,
                        })
                        this.stats.mode = this.config.enableFlashLoans ? "HYBRID" : "TRADING"

                        // Start regular trading
                        if (!this.tradingIntervalId) {
                            await this.runTradingCycle()
                            this.tradingIntervalId = setInterval(
                                () => this.runTradingCycle(),
                                this.config.intervalMs
                            )
                        }
                    }
                }
            }

            if (result.errors.length > 0) {
                this.log.warn({
                    event: "FlashLoanCycleErrors",
                    errors: result.errors.slice(0, 5), // Log first 5 errors
                })
            }
        } catch (e) {
            this.log.error({
                event: "FlashLoanCycleError",
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    private async runTradingCycle(): Promise<void> {
        try {
            this.log.debug({ event: "TradingCycleStart" })

            // Fetch prices
            await this.marketDataService.fetchPrices()

            // Check risk limits
            const riskStatus = await this.riskManager.checkRisk()
            if (!riskStatus.isTradeAllowed) {
                this.log.debug({
                    event: "TradingBlocked",
                    reason: riskStatus.reason,
                })
                await this.tradingStrategy.checkAndManagePositions()
                return
            }

            // Manage existing positions
            await this.tradingStrategy.checkAndManagePositions()

            // Look for new signals
            const signals = await this.marketDataService.getHighProbabilitySignals()

            if (signals.length > 0) {
                const availableCapital = this.riskManager.getAvailableCapital()

                for (const signal of signals) {
                    if (availableCapital.lt(this.config.minTradeSize)) break

                    const position = await this.tradingStrategy.executeSignal(
                        signal,
                        availableCapital
                    )

                    if (position) {
                        this.stats.tradesExecuted++
                        break // One trade per cycle
                    }
                }
            }

            // Update stats
            const tradingStats = this.tradingStrategy.getStats()
            this.stats.tradingProfit = tradingStats.netPnl
            this.stats.totalProfit = this.stats.flashLoanProfit.add(this.stats.tradingProfit)

            // Periodic stats logging
            if (Math.random() < 0.1) { // ~10% of cycles
                await this.logStats()
            }
        } catch (e) {
            this.log.error({
                event: "TradingCycleError",
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    private async logStats(): Promise<void> {
        const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000)
        const currentBalance = await this.solanaService.getUsdcBalance()

        this.log.info({
            event: "BotStats",
            mode: this.stats.mode,
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            currentCapital: currentBalance.toString(),
            totalProfit: this.stats.totalProfit.toString(),
            flashLoanProfit: this.stats.flashLoanProfit.toString(),
            tradingProfit: this.stats.tradingProfit.toString(),
            arbitrageExecuted: this.stats.arbitrageExecuted,
            tradesExecuted: this.stats.tradesExecuted,
        })
    }

    getStats(): BotStats {
        return {
            ...this.stats,
            uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
        }
    }

    async emergencyStop(): Promise<void> {
        await this.stop()
        await this.tradingStrategy.closeAllPositions()
        this.log.error({ event: "EmergencyStopExecuted" })
    }
}

// Default self-funding configuration
export const DEFAULT_SELF_FUNDING_CONFIG: Partial<SelfFundingConfig> = {
    // Flash loan settings
    enableFlashLoans: true,
    minFlashLoanProfit: 0.1, // 0.1% minimum profit
    maxFlashLoanSize: 5000,  // $5k max per flash loan
    flashLoanIntervalMs: 10000, // Scan every 10 seconds

    // Profit reinvestment
    profitReinvestPercent: 80, // Reinvest 80% of profits
    profitReservePercent: 20,  // Keep 20% as reserve

    // Bootstrap mode
    bootstrapMode: true,
    targetBootstrapCapital: 100, // Target $100 before regular trading
}
