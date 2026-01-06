import "reflect-metadata"
import * as dotenv from "dotenv"
import * as path from "path"

// Load .env.solana file
dotenv.config({ path: path.resolve(process.cwd(), ".env.solana") })

import { configure } from "log4js"
import { Container } from "typedi"
import { Log } from "../Log"

// Configure log4js to output to console
configure({
    appenders: {
        console: {
            type: "console",
            layout: {
                type: "pattern",
                pattern: "%d{ISO8601} [%p] %c - %m"
            }
        }
    },
    categories: {
        default: { appenders: ["console"], level: "debug" }
    }
})
import { SolanaService } from "./SolanaService"
import { JupiterService } from "./JupiterService"
import { MarketDataService } from "./MarketDataService"
import { TradingStrategy } from "./TradingStrategy"
import { RiskManager } from "./RiskManager"
import { FlashLoanService } from "./FlashLoanService"
import { Backtester } from "./Backtester"
import { SolanaBot } from "./SolanaBot"
import { SelfFundingBot, SelfFundingConfig } from "./SelfFundingBot"
import {
    loadConfigFromEnv,
    loadSelfFundingConfigFromEnv,
    validateConfig,
    SelfFundingBotConfig,
} from "./config"

const log = Log.getLogger("SolanaBotMain")

// Check if running in self-funding mode
const SELF_FUNDING_MODE = process.env.SELF_FUNDING_MODE === "true" ||
                          process.env.BOOTSTRAP_MODE === "true" ||
                          process.env.ENABLE_FLASH_LOANS === "true"

async function main(): Promise<void> {
    log.info({
        event: "SolanaTradingBotStarting",
        mode: SELF_FUNDING_MODE ? "SELF_FUNDING" : "STANDARD",
    })

    // Initialize services via dependency injection
    const solanaService = Container.get(SolanaService)
    const jupiterService = Container.get(JupiterService)
    const marketDataService = Container.get(MarketDataService)
    const tradingStrategy = Container.get(TradingStrategy)
    const riskManager = Container.get(RiskManager)
    const flashLoanService = Container.get(FlashLoanService)
    const backtester = Container.get(Backtester)

    if (SELF_FUNDING_MODE) {
        // Self-funding mode: Can start with $0 using flash loans
        const config = loadSelfFundingConfigFromEnv()
        const errors = validateConfig(config)

        if (errors.length > 0) {
            log.error({ event: "ConfigurationError", errors })
            console.error("\nConfiguration errors:")
            errors.forEach((e) => console.error(`  - ${e}`))
            process.exit(1)
        }

        const bot = new SelfFundingBot(
            solanaService,
            jupiterService,
            marketDataService,
            tradingStrategy,
            riskManager,
            flashLoanService,
            backtester
        )

        try {
            await bot.init(config as SelfFundingConfig)

            // Run backtest if configured
            if (config.runBacktestOnStart) {
                console.log("\n🔬 Running backtest before live trading...\n")
                await bot.runBacktest(config.backtestDays)
                console.log("\n✅ Backtest complete. Starting live trading...\n")
            }

            await bot.start()

            console.log("\n" + "=".repeat(60))
            console.log("🚀 SELF-FUNDING SOLANA BOT STARTED")
            console.log("=".repeat(60))
            console.log(`Mode: ${config.bootstrapMode ? "BOOTSTRAP (starting from $0)" : "HYBRID"}`)
            console.log(`Flash Loans: ${config.enableFlashLoans ? "ENABLED" : "DISABLED"}`)
            console.log(`Target Bootstrap Capital: $${config.targetBootstrapCapital}`)
            console.log("=".repeat(60))
            console.log("Press Ctrl+C to stop.\n")

            // Handle graceful shutdown
            const shutdown = async (signal: string) => {
                log.info({ event: "ShutdownSignal", signal })
                await bot.stop()
                const stats = bot.getStats()
                console.log("\n" + "=".repeat(60))
                console.log("📊 FINAL STATS")
                console.log("=".repeat(60))
                console.log(`Total Capital: $${stats.totalCapital.toString()}`)
                console.log(`Flash Loan Profit: $${stats.flashLoanProfit.toString()}`)
                console.log(`Trading Profit: $${stats.tradingProfit.toString()}`)
                console.log(`Total Profit: $${stats.totalProfit.toString()}`)
                console.log(`Arbitrages Executed: ${stats.arbitrageExecuted}`)
                console.log(`Trades Executed: ${stats.tradesExecuted}`)
                console.log("=".repeat(60) + "\n")
                process.exit(0)
            }

            process.on("SIGINT", () => shutdown("SIGINT"))
            process.on("SIGTERM", () => shutdown("SIGTERM"))

            await new Promise(() => {})
        } catch (e) {
            log.error({
                event: "FatalError",
                error: e instanceof Error ? e.message : String(e),
            })
            process.exit(1)
        }
    } else {
        // Standard mode: Requires initial capital
        const config = loadConfigFromEnv()
        const errors = validateConfig(config)

        if (errors.length > 0) {
            log.error({ event: "ConfigurationError", errors })
            console.error("\nConfiguration errors:")
            errors.forEach((e) => console.error(`  - ${e}`))
            console.error("\nPlease create a .env.solana file with required variables.")
            process.exit(1)
        }

        const bot = new SolanaBot(
            solanaService,
            jupiterService,
            marketDataService,
            tradingStrategy,
            riskManager
        )

        try {
            await bot.init(config)
            await bot.start()

            log.info({
                event: "BotRunning",
                message: "Solana trading bot is now running. Press Ctrl+C to stop.",
            })

            const shutdown = async (signal: string) => {
                log.info({ event: "ShutdownSignal", signal })
                await bot.stop()
                const status = await bot.getStatus()
                log.info({ event: "FinalStats", ...status.stats, ...status.riskStatus })
                process.exit(0)
            }

            process.on("SIGINT", () => shutdown("SIGINT"))
            process.on("SIGTERM", () => shutdown("SIGTERM"))

            await new Promise(() => {})
        } catch (e) {
            log.error({
                event: "FatalError",
                error: e instanceof Error ? e.message : String(e),
            })
            process.exit(1)
        }
    }
}

main().catch((e) => {
    console.error("Unhandled error:", e)
    process.exit(1)
})
