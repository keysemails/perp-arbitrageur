import "reflect-metadata"
import { Container } from "typedi"
import { Log } from "../Log"
import { SolanaService } from "./SolanaService"
import { JupiterService } from "./JupiterService"
import { MarketDataService } from "./MarketDataService"
import { TradingStrategy } from "./TradingStrategy"
import { RiskManager } from "./RiskManager"
import { SolanaBot } from "./SolanaBot"
import { loadConfigFromEnv, validateConfig } from "./config"

const log = Log.getLogger("SolanaBotMain")

async function main(): Promise<void> {
    log.info({ event: "SolanaTradingBotStarting" })

    // Load configuration
    const config = loadConfigFromEnv()
    const errors = validateConfig(config)

    if (errors.length > 0) {
        log.error({
            event: "ConfigurationError",
            errors,
        })
        console.error("\nConfiguration errors:")
        errors.forEach((e) => console.error(`  - ${e}`))
        console.error("\nPlease create a .env.solana file with required variables.")
        console.error("See README or config.ts for details.\n")
        process.exit(1)
    }

    // Initialize services via dependency injection
    const solanaService = Container.get(SolanaService)
    const jupiterService = Container.get(JupiterService)
    const marketDataService = Container.get(MarketDataService)
    const tradingStrategy = Container.get(TradingStrategy)
    const riskManager = Container.get(RiskManager)

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

        // Handle graceful shutdown
        const shutdown = async (signal: string) => {
            log.info({ event: "ShutdownSignal", signal })
            await bot.stop()

            // Log final stats
            const status = await bot.getStatus()
            log.info({
                event: "FinalStats",
                ...status.stats,
                ...status.riskStatus,
            })

            process.exit(0)
        }

        process.on("SIGINT", () => shutdown("SIGINT"))
        process.on("SIGTERM", () => shutdown("SIGTERM"))

        // Keep the process running
        await new Promise(() => {})
    } catch (e) {
        log.error({
            event: "FatalError",
            error: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
        })
        process.exit(1)
    }
}

main().catch((e) => {
    console.error("Unhandled error:", e)
    process.exit(1)
})
