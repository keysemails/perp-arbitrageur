import Big from "big.js"
import { Service } from "typedi"
import { Log } from "../Log"
import { TradingStrategy, TradeStats } from "./TradingStrategy"
import { SolanaService } from "./SolanaService"

export interface RiskLimits {
    initialCapital: Big
    maxDrawdownPercent: number
    maxDailyLossPercent: number
    maxPositionSizePercent: number
    minCapitalReserve: Big
    maxTradesPerHour: number
    cooldownAfterLoss: number // seconds
}

export interface RiskStatus {
    currentCapital: Big
    totalPnl: Big
    drawdownPercent: number
    dailyPnl: Big
    tradesThisHour: number
    isTradeAllowed: boolean
    reason: string
}

@Service()
export class RiskManager {
    private readonly log = Log.getLogger(RiskManager.name)
    private solanaService!: SolanaService
    private tradingStrategy!: TradingStrategy

    private limits: RiskLimits = {
        initialCapital: Big(100), // $100 USDC
        maxDrawdownPercent: 10, // Max 10% drawdown
        maxDailyLossPercent: 5, // Max 5% daily loss
        maxPositionSizePercent: 30, // Max 30% per position
        minCapitalReserve: Big(10), // Keep at least $10 reserve
        maxTradesPerHour: 20, // Max 20 trades per hour
        cooldownAfterLoss: 300, // 5 minute cooldown after a loss
    }

    private tradeTimestamps: number[] = []
    private dailyPnl: Big = Big(0)
    private dailyStartTime: number = Date.now()
    private lastLossTime: number = 0
    private isPaused: boolean = false

    init(solanaService: SolanaService, tradingStrategy: TradingStrategy): void {
        this.solanaService = solanaService
        this.tradingStrategy = tradingStrategy

        this.log.info({
            event: "RiskManagerInitialized",
            initialCapital: this.limits.initialCapital.toString(),
            maxDrawdownPercent: this.limits.maxDrawdownPercent,
            maxDailyLossPercent: this.limits.maxDailyLossPercent,
        })
    }

    async checkRisk(): Promise<RiskStatus> {
        const usdcBalance = await this.solanaService.getUsdcBalance()
        const positionValue = this.tradingStrategy.getPositionValue()
        const currentCapital = usdcBalance.add(positionValue)
        const stats = this.tradingStrategy.getStats()

        // Reset daily PnL at midnight
        this.checkDailyReset()

        // Calculate metrics
        const totalPnl = stats.netPnl
        const drawdownPercent = this.limits.initialCapital.gt(0)
            ? Number(this.limits.initialCapital
                  .sub(currentCapital)
                  .div(this.limits.initialCapital)
                  .mul(100)
                  .toString())
            : 0

        // Count trades in last hour
        const hourAgo = Date.now() - 3600000
        this.tradeTimestamps = this.tradeTimestamps.filter((t) => t > hourAgo)
        const tradesThisHour = this.tradeTimestamps.length

        let isTradeAllowed = true
        let reason = "Trading allowed"

        // Check if paused
        if (this.isPaused) {
            isTradeAllowed = false
            reason = "Trading manually paused"
        }
        // Check max drawdown
        else if (drawdownPercent >= this.limits.maxDrawdownPercent) {
            isTradeAllowed = false
            reason = `Max drawdown reached: ${drawdownPercent.toFixed(2)}%`
            this.log.warn({
                event: "MaxDrawdownReached",
                drawdown: drawdownPercent,
                limit: this.limits.maxDrawdownPercent,
            })
        }
        // Check daily loss limit
        else if (
            this.dailyPnl.lt(0) &&
            this.dailyPnl
                .abs()
                .div(this.limits.initialCapital)
                .mul(100)
                .gte(this.limits.maxDailyLossPercent)
        ) {
            isTradeAllowed = false
            reason = `Daily loss limit reached: ${this.dailyPnl.toString()} USDC`
            this.log.warn({
                event: "DailyLossLimitReached",
                dailyPnl: this.dailyPnl.toString(),
                limit: this.limits.maxDailyLossPercent,
            })
        }
        // Check minimum capital reserve
        else if (usdcBalance.lt(this.limits.minCapitalReserve)) {
            isTradeAllowed = false
            reason = `Below minimum reserve: ${usdcBalance.toString()} USDC`
        }
        // Check trades per hour
        else if (tradesThisHour >= this.limits.maxTradesPerHour) {
            isTradeAllowed = false
            reason = `Max trades per hour reached: ${tradesThisHour}`
        }
        // Check cooldown after loss
        else if (
            this.lastLossTime > 0 &&
            Date.now() - this.lastLossTime < this.limits.cooldownAfterLoss * 1000
        ) {
            const remaining = Math.ceil(
                (this.limits.cooldownAfterLoss * 1000 - (Date.now() - this.lastLossTime)) /
                    1000
            )
            isTradeAllowed = false
            reason = `Cooldown after loss: ${remaining}s remaining`
        }

        const status: RiskStatus = {
            currentCapital,
            totalPnl,
            drawdownPercent,
            dailyPnl: this.dailyPnl,
            tradesThisHour,
            isTradeAllowed,
            reason,
        }

        this.log.debug({
            event: "RiskCheck",
            ...status,
            currentCapital: status.currentCapital.toString(),
            totalPnl: status.totalPnl.toString(),
            dailyPnl: status.dailyPnl.toString(),
        })

        return status
    }

    private checkDailyReset(): void {
        const now = Date.now()
        const dayStart = new Date().setHours(0, 0, 0, 0)

        if (this.dailyStartTime < dayStart) {
            this.log.info({
                event: "DailyReset",
                previousDailyPnl: this.dailyPnl.toString(),
            })
            this.dailyPnl = Big(0)
            this.dailyStartTime = now
        }
    }

    recordTrade(pnl: Big): void {
        this.tradeTimestamps.push(Date.now())
        this.dailyPnl = this.dailyPnl.add(pnl)

        if (pnl.lt(0)) {
            this.lastLossTime = Date.now()
        }

        this.log.info({
            event: "TradeRecorded",
            pnl: pnl.toString(),
            dailyPnl: this.dailyPnl.toString(),
            tradesThisHour: this.tradeTimestamps.length,
        })
    }

    getAvailableCapital(): Big {
        const stats = this.tradingStrategy.getStats()
        const openPositions = this.tradingStrategy.getOpenPositions()

        // Calculate capital in open positions
        let capitalInPositions = Big(0)
        for (const pos of openPositions) {
            capitalInPositions = capitalInPositions.add(pos.usdcSpent)
        }

        // Available = initial + PnL - positions - reserve
        let available = this.limits.initialCapital
            .add(stats.netPnl)
            .sub(capitalInPositions)
            .sub(this.limits.minCapitalReserve)

        if (available.lt(0)) {
            available = Big(0)
        }

        return available
    }

    getMaxPositionSize(): Big {
        const available = this.getAvailableCapital()
        const maxSize = this.limits.initialCapital.mul(
            this.limits.maxPositionSizePercent / 100
        )
        return available.lt(maxSize) ? available : maxSize
    }

    pause(): void {
        this.isPaused = true
        this.log.warn({ event: "TradingPaused" })
    }

    resume(): void {
        this.isPaused = false
        this.log.info({ event: "TradingResumed" })
    }

    setLimits(limits: Partial<RiskLimits>): void {
        if (limits.initialCapital !== undefined)
            this.limits.initialCapital = limits.initialCapital
        if (limits.maxDrawdownPercent !== undefined)
            this.limits.maxDrawdownPercent = limits.maxDrawdownPercent
        if (limits.maxDailyLossPercent !== undefined)
            this.limits.maxDailyLossPercent = limits.maxDailyLossPercent
        if (limits.maxPositionSizePercent !== undefined)
            this.limits.maxPositionSizePercent = limits.maxPositionSizePercent
        if (limits.minCapitalReserve !== undefined)
            this.limits.minCapitalReserve = limits.minCapitalReserve
        if (limits.maxTradesPerHour !== undefined)
            this.limits.maxTradesPerHour = limits.maxTradesPerHour
        if (limits.cooldownAfterLoss !== undefined)
            this.limits.cooldownAfterLoss = limits.cooldownAfterLoss

        this.log.info({
            event: "RiskLimitsUpdated",
            limits: {
                initialCapital: this.limits.initialCapital.toString(),
                maxDrawdownPercent: this.limits.maxDrawdownPercent,
                maxDailyLossPercent: this.limits.maxDailyLossPercent,
                maxPositionSizePercent: this.limits.maxPositionSizePercent,
                minCapitalReserve: this.limits.minCapitalReserve.toString(),
                maxTradesPerHour: this.limits.maxTradesPerHour,
                cooldownAfterLoss: this.limits.cooldownAfterLoss,
            },
        })
    }

    getLimits(): RiskLimits {
        return { ...this.limits }
    }

    async emergencyStop(): Promise<void> {
        this.log.error({ event: "EmergencyStop" })
        this.isPaused = true
        await this.tradingStrategy.closeAllPositions()
    }
}
