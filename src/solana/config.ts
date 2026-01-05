export interface BotConfig {
    // Network configuration
    rpcEndpoint: string
    privateKey: string

    // Trading parameters
    initialCapital: number // In USDC
    slippageBps: number // Basis points (50 = 0.5%)
    intervalMs: number // Milliseconds between cycles

    // Position sizing
    maxPositions: number
    positionSizePercent: number // Percentage of capital per trade
    minTradeSize: number // Minimum trade in USDC

    // Profit targets
    takeProfitPercent: number // Take profit percentage
    stopLossPercent: number // Stop loss percentage

    // Risk management
    maxDrawdownPercent: number
    maxDailyLossPercent: number

    // Market data
    priceHistoryLength: number
}

// Default configuration optimized for high-volume, low-profit scalping
export const DEFAULT_CONFIG: BotConfig = {
    // Network - will be overridden by environment variables
    rpcEndpoint: "https://api.mainnet-beta.solana.com",
    privateKey: "",

    // Trading parameters
    initialCapital: 100, // $100 USDC starting capital
    slippageBps: 50, // 0.5% max slippage
    intervalMs: 5000, // Check every 5 seconds for high frequency

    // Position sizing for high volume
    maxPositions: 3, // Up to 3 concurrent positions
    positionSizePercent: 30, // 30% of capital per position ($30)
    minTradeSize: 5, // Minimum $5 per trade

    // Low profit targets for high probability
    takeProfitPercent: 0.5, // 0.5% take profit (~$0.15 on $30)
    stopLossPercent: 0.3, // 0.3% stop loss (~$0.09 on $30)

    // Risk management
    maxDrawdownPercent: 10, // Stop trading if down 10% ($10)
    maxDailyLossPercent: 5, // Stop trading if down 5% in a day ($5)

    // Market data
    priceHistoryLength: 60, // Keep 60 price points (5 minutes at 5s intervals)
}

export function loadConfigFromEnv(): BotConfig {
    const config = { ...DEFAULT_CONFIG }

    // Required
    config.rpcEndpoint = process.env.SOLANA_RPC_ENDPOINT || config.rpcEndpoint
    config.privateKey = process.env.SOLANA_PRIVATE_KEY || ""

    // Optional overrides
    if (process.env.INITIAL_CAPITAL) {
        config.initialCapital = parseFloat(process.env.INITIAL_CAPITAL)
    }
    if (process.env.SLIPPAGE_BPS) {
        config.slippageBps = parseInt(process.env.SLIPPAGE_BPS)
    }
    if (process.env.INTERVAL_MS) {
        config.intervalMs = parseInt(process.env.INTERVAL_MS)
    }
    if (process.env.MAX_POSITIONS) {
        config.maxPositions = parseInt(process.env.MAX_POSITIONS)
    }
    if (process.env.POSITION_SIZE_PERCENT) {
        config.positionSizePercent = parseFloat(process.env.POSITION_SIZE_PERCENT)
    }
    if (process.env.MIN_TRADE_SIZE) {
        config.minTradeSize = parseFloat(process.env.MIN_TRADE_SIZE)
    }
    if (process.env.TAKE_PROFIT_PERCENT) {
        config.takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT)
    }
    if (process.env.STOP_LOSS_PERCENT) {
        config.stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT)
    }
    if (process.env.MAX_DRAWDOWN_PERCENT) {
        config.maxDrawdownPercent = parseFloat(process.env.MAX_DRAWDOWN_PERCENT)
    }
    if (process.env.MAX_DAILY_LOSS_PERCENT) {
        config.maxDailyLossPercent = parseFloat(process.env.MAX_DAILY_LOSS_PERCENT)
    }
    if (process.env.PRICE_HISTORY_LENGTH) {
        config.priceHistoryLength = parseInt(process.env.PRICE_HISTORY_LENGTH)
    }

    return config
}

export function validateConfig(config: BotConfig): string[] {
    const errors: string[] = []

    if (!config.privateKey) {
        errors.push("SOLANA_PRIVATE_KEY is required")
    }
    if (!config.rpcEndpoint) {
        errors.push("SOLANA_RPC_ENDPOINT is required")
    }
    if (config.initialCapital < 0) {
        errors.push("INITIAL_CAPITAL must be non-negative")
    }
    if (config.slippageBps < 0 || config.slippageBps > 1000) {
        errors.push("SLIPPAGE_BPS must be between 0 and 1000")
    }
    if (config.intervalMs < 1000) {
        errors.push("INTERVAL_MS must be at least 1000ms")
    }
    if (config.maxPositions < 1) {
        errors.push("MAX_POSITIONS must be at least 1")
    }
    if (config.positionSizePercent <= 0 || config.positionSizePercent > 100) {
        errors.push("POSITION_SIZE_PERCENT must be between 0 and 100")
    }
    if (config.takeProfitPercent <= 0) {
        errors.push("TAKE_PROFIT_PERCENT must be positive")
    }
    if (config.stopLossPercent <= 0) {
        errors.push("STOP_LOSS_PERCENT must be positive")
    }
    if (config.maxDrawdownPercent <= 0 || config.maxDrawdownPercent > 100) {
        errors.push("MAX_DRAWDOWN_PERCENT must be between 0 and 100")
    }
    if (config.maxDailyLossPercent <= 0 || config.maxDailyLossPercent > 100) {
        errors.push("MAX_DAILY_LOSS_PERCENT must be between 0 and 100")
    }

    return errors
}

// Self-funding bot configuration
export interface SelfFundingBotConfig extends BotConfig {
    // Flash loan settings
    enableFlashLoans: boolean
    minFlashLoanProfit: number
    maxFlashLoanSize: number
    flashLoanIntervalMs: number

    // Bootstrap mode
    bootstrapMode: boolean
    targetBootstrapCapital: number

    // Profit management
    profitReinvestPercent: number
    profitReservePercent: number

    // Backtest
    runBacktestOnStart: boolean
    backtestDays: number
}

export const DEFAULT_SELF_FUNDING_CONFIG: SelfFundingBotConfig = {
    ...DEFAULT_CONFIG,
    initialCapital: 0, // Start with $0!

    // Flash loan settings
    enableFlashLoans: true,
    minFlashLoanProfit: 0.1, // 0.1% minimum profit
    maxFlashLoanSize: 5000,  // $5k max per flash loan
    flashLoanIntervalMs: 10000, // Scan every 10 seconds

    // Bootstrap mode
    bootstrapMode: true,
    targetBootstrapCapital: 100, // Target $100 before regular trading

    // Profit management
    profitReinvestPercent: 80,
    profitReservePercent: 20,

    // Backtest
    runBacktestOnStart: true,
    backtestDays: 30,
}

export function loadSelfFundingConfigFromEnv(): SelfFundingBotConfig {
    const baseConfig = loadConfigFromEnv()
    const config: SelfFundingBotConfig = {
        ...DEFAULT_SELF_FUNDING_CONFIG,
        ...baseConfig,
    }

    // Override with self-funding specific env vars
    if (process.env.ENABLE_FLASH_LOANS) {
        config.enableFlashLoans = process.env.ENABLE_FLASH_LOANS === "true"
    }
    if (process.env.MIN_FLASH_LOAN_PROFIT) {
        config.minFlashLoanProfit = parseFloat(process.env.MIN_FLASH_LOAN_PROFIT)
    }
    if (process.env.MAX_FLASH_LOAN_SIZE) {
        config.maxFlashLoanSize = parseFloat(process.env.MAX_FLASH_LOAN_SIZE)
    }
    if (process.env.FLASH_LOAN_INTERVAL_MS) {
        config.flashLoanIntervalMs = parseInt(process.env.FLASH_LOAN_INTERVAL_MS)
    }
    if (process.env.BOOTSTRAP_MODE) {
        config.bootstrapMode = process.env.BOOTSTRAP_MODE === "true"
    }
    if (process.env.TARGET_BOOTSTRAP_CAPITAL) {
        config.targetBootstrapCapital = parseFloat(process.env.TARGET_BOOTSTRAP_CAPITAL)
    }
    if (process.env.RUN_BACKTEST) {
        config.runBacktestOnStart = process.env.RUN_BACKTEST === "true"
    }
    if (process.env.BACKTEST_DAYS) {
        config.backtestDays = parseInt(process.env.BACKTEST_DAYS)
    }

    return config
}
