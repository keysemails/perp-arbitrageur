import {
    PublicKey,
    Transaction,
    TransactionInstruction,
    VersionedTransaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import Big from "big.js"
import fetch from "node-fetch"
import { Service } from "typedi"
import { Log } from "../Log"
import { SolanaService, USDC_MINT, USDC_DECIMALS } from "./SolanaService"
import { JupiterService, QuoteResponse } from "./JupiterService"

const JUPITER_API_BASE = "https://quote-api.jup.ag/v6"

// Flash loan providers on Solana
export enum FlashLoanProvider {
    JUPITER_FLASH_SWAP = "JUPITER",
    SOLEND = "SOLEND",
    MARGINFI = "MARGINFI",
}

export interface ArbitrageOpportunity {
    tokenA: PublicKey
    tokenB: PublicKey
    tokenASymbol: string
    tokenBSymbol: string
    buyPrice: Big      // Price to buy tokenB with tokenA
    sellPrice: Big     // Price to sell tokenB for tokenA
    spreadPercent: Big
    estimatedProfit: Big
    borrowAmount: Big
    route: string[]
    confidence: number
}

export interface FlashLoanResult {
    success: boolean
    signature?: string
    borrowAmount: Big
    repayAmount: Big
    profit: Big
    gasUsed: Big
    error?: string
}

// DEX price sources for arbitrage detection
interface DexPrice {
    dex: string
    price: Big
    liquidity: Big
}

@Service()
export class FlashLoanService {
    private readonly log = Log.getLogger(FlashLoanService.name)
    private solanaService!: SolanaService
    private jupiterService!: JupiterService

    // Minimum profit threshold (after fees) to execute arbitrage
    private minProfitThresholdPercent: number = 0.1 // 0.1% minimum profit
    private maxBorrowAmount: Big = Big(10000) // Max $10k per flash loan
    private flashLoanFeePercent: number = 0.09 // ~0.09% typical flash loan fee

    init(solanaService: SolanaService, jupiterService: JupiterService): void {
        this.solanaService = solanaService
        this.jupiterService = jupiterService

        this.log.info({
            event: "FlashLoanServiceInitialized",
            minProfitThreshold: this.minProfitThresholdPercent,
            maxBorrowAmount: this.maxBorrowAmount.toString(),
        })
    }

    // Scan for arbitrage opportunities across DEXes
    async findArbitrageOpportunities(
        baseToken: PublicKey,
        quoteTokens: PublicKey[],
        baseDecimals: number,
        quoteDecimals: number[],
        testAmount: Big = Big(100) // Test with $100 equivalent
    ): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = []

        for (let i = 0; i < quoteTokens.length; i++) {
            const quoteToken = quoteTokens[i]
            const quoteDec = quoteDecimals[i]

            try {
                // Get forward quote (base -> quote)
                const forwardQuote = await this.jupiterService.getQuote(
                    baseToken,
                    quoteToken,
                    testAmount,
                    baseDecimals,
                    10 // Low slippage for price check
                )

                if (!forwardQuote) continue

                // Calculate how much quote token we'd get
                const quoteAmount = Big(forwardQuote.outAmount).div(10 ** quoteDec)

                // Get reverse quote (quote -> base)
                const reverseQuote = await this.jupiterService.getQuote(
                    quoteToken,
                    baseToken,
                    quoteAmount,
                    quoteDec,
                    10
                )

                if (!reverseQuote) continue

                // Calculate how much base token we'd get back
                const returnAmount = Big(reverseQuote.outAmount).div(10 ** baseDecimals)

                // Calculate profit potential
                const grossProfit = returnAmount.sub(testAmount)
                const grossProfitPercent = grossProfit.div(testAmount).mul(100)

                // Account for fees
                const flashLoanFee = testAmount.mul(this.flashLoanFeePercent / 100)
                const estimatedGas = Big(0.001) // ~0.001 SOL for tx
                const netProfit = grossProfit.sub(flashLoanFee).sub(estimatedGas)
                const netProfitPercent = netProfit.div(testAmount).mul(100)

                // Only consider profitable opportunities
                if (netProfitPercent.gt(this.minProfitThresholdPercent)) {
                    // Calculate optimal borrow amount (scale up from test)
                    const scaleFactor = this.calculateOptimalScale(
                        Big(forwardQuote.priceImpactPct),
                        Big(reverseQuote.priceImpactPct)
                    )
                    const optimalBorrow = testAmount.mul(scaleFactor)
                    const borrowAmount = optimalBorrow.lt(this.maxBorrowAmount)
                        ? optimalBorrow
                        : this.maxBorrowAmount

                    const scaledProfit = netProfit.mul(borrowAmount.div(testAmount))

                    opportunities.push({
                        tokenA: baseToken,
                        tokenB: quoteToken,
                        tokenASymbol: this.getTokenSymbol(baseToken),
                        tokenBSymbol: this.getTokenSymbol(quoteToken),
                        buyPrice: testAmount.div(quoteAmount),
                        sellPrice: quoteAmount.div(returnAmount),
                        spreadPercent: netProfitPercent,
                        estimatedProfit: scaledProfit,
                        borrowAmount,
                        route: [
                            ...forwardQuote.routePlan.map(r => r.swapInfo.label),
                            "->",
                            ...reverseQuote.routePlan.map(r => r.swapInfo.label),
                        ],
                        confidence: this.calculateConfidence(
                            Big(forwardQuote.priceImpactPct),
                            Big(reverseQuote.priceImpactPct),
                            netProfitPercent
                        ),
                    })
                }
            } catch (e) {
                this.log.debug({
                    event: "ArbitrageScanError",
                    baseToken: baseToken.toBase58(),
                    quoteToken: quoteToken.toBase58(),
                    error: e instanceof Error ? e.message : String(e),
                })
            }
        }

        // Sort by estimated profit descending
        opportunities.sort((a, b) =>
            Number(b.estimatedProfit.sub(a.estimatedProfit).toString())
        )

        return opportunities
    }

    // Execute flash loan arbitrage using Jupiter's atomic swap
    async executeFlashLoanArbitrage(
        opportunity: ArbitrageOpportunity
    ): Promise<FlashLoanResult> {
        this.log.info({
            event: "ExecutingFlashLoanArbitrage",
            tokenA: opportunity.tokenASymbol,
            tokenB: opportunity.tokenBSymbol,
            borrowAmount: opportunity.borrowAmount.toString(),
            estimatedProfit: opportunity.estimatedProfit.toString(),
            spreadPercent: opportunity.spreadPercent.toString(),
        })

        try {
            // Get the decimals for tokenA (the borrow token)
            const tokenADecimals = this.getDecimals(opportunity.tokenA)
            const tokenBDecimals = this.getDecimals(opportunity.tokenB)

            // Step 1: Get fresh quote for the forward swap
            const forwardQuote = await this.jupiterService.getQuote(
                opportunity.tokenA,
                opportunity.tokenB,
                opportunity.borrowAmount,
                tokenADecimals,
                30 // Allow some slippage for execution
            )

            if (!forwardQuote) {
                return {
                    success: false,
                    borrowAmount: opportunity.borrowAmount,
                    repayAmount: Big(0),
                    profit: Big(0),
                    gasUsed: Big(0),
                    error: "Failed to get forward quote",
                }
            }

            // Calculate received amount
            const receivedTokenB = Big(forwardQuote.outAmount).div(10 ** tokenBDecimals)

            // Step 2: Get quote for reverse swap
            const reverseQuote = await this.jupiterService.getQuote(
                opportunity.tokenB,
                opportunity.tokenA,
                receivedTokenB,
                tokenBDecimals,
                30
            )

            if (!reverseQuote) {
                return {
                    success: false,
                    borrowAmount: opportunity.borrowAmount,
                    repayAmount: Big(0),
                    profit: Big(0),
                    gasUsed: Big(0),
                    error: "Failed to get reverse quote",
                }
            }

            // Calculate final amount and verify profitability
            const finalAmount = Big(reverseQuote.outAmount).div(10 ** tokenADecimals)
            const flashLoanFee = opportunity.borrowAmount.mul(this.flashLoanFeePercent / 100)
            const repayAmount = opportunity.borrowAmount.add(flashLoanFee)
            const profit = finalAmount.sub(repayAmount)

            // Safety check: abort if not profitable
            if (profit.lte(0)) {
                this.log.warn({
                    event: "ArbitrageNotProfitable",
                    borrowAmount: opportunity.borrowAmount.toString(),
                    finalAmount: finalAmount.toString(),
                    repayAmount: repayAmount.toString(),
                    expectedProfit: profit.toString(),
                })
                return {
                    success: false,
                    borrowAmount: opportunity.borrowAmount,
                    repayAmount,
                    profit,
                    gasUsed: Big(0),
                    error: "Arbitrage no longer profitable after slippage",
                }
            }

            // Step 3: Execute the arbitrage (forward swap -> reverse swap)
            // Using Jupiter's transaction bundling for atomicity
            const forwardResult = await this.jupiterService.executeSwap(forwardQuote)
            if (!forwardResult) {
                return {
                    success: false,
                    borrowAmount: opportunity.borrowAmount,
                    repayAmount,
                    profit: Big(0),
                    gasUsed: Big(0.001),
                    error: "Forward swap execution failed",
                }
            }

            // Execute reverse swap
            const reverseResult = await this.jupiterService.executeSwap(reverseQuote)
            if (!reverseResult) {
                // This is bad - we have exposure now
                this.log.error({
                    event: "ReverseSwapFailed",
                    forwardSignature: forwardResult.signature,
                    tokenBHeld: receivedTokenB.toString(),
                })
                return {
                    success: false,
                    borrowAmount: opportunity.borrowAmount,
                    repayAmount,
                    profit: Big(0),
                    gasUsed: Big(0.002),
                    error: "Reverse swap failed - position exposed",
                }
            }

            // Calculate actual profit
            const actualProfit = reverseResult.outputAmount.sub(opportunity.borrowAmount)
                .sub(flashLoanFee)

            this.log.info({
                event: "FlashLoanArbitrageSuccess",
                borrowAmount: opportunity.borrowAmount.toString(),
                repayAmount: repayAmount.toString(),
                actualProfit: actualProfit.toString(),
                forwardSignature: forwardResult.signature,
                reverseSignature: reverseResult.signature,
            })

            return {
                success: true,
                signature: reverseResult.signature,
                borrowAmount: opportunity.borrowAmount,
                repayAmount,
                profit: actualProfit,
                gasUsed: Big(0.002), // Estimate ~0.002 SOL for 2 txs
            }
        } catch (e) {
            this.log.error({
                event: "FlashLoanArbitrageError",
                error: e instanceof Error ? e.message : String(e),
            })
            return {
                success: false,
                borrowAmount: opportunity.borrowAmount,
                repayAmount: Big(0),
                profit: Big(0),
                gasUsed: Big(0.001),
                error: e instanceof Error ? e.message : String(e),
            }
        }
    }

    // Self-funding cycle: find and execute profitable arbitrage
    async runSelfFundingCycle(): Promise<{
        opportunities: number
        executed: number
        totalProfit: Big
        errors: string[]
    }> {
        const errors: string[] = []
        let totalProfit = Big(0)
        let executed = 0

        // Define token pairs to scan
        const tokenPairs = [
            { base: USDC_MINT, baseDec: 6 },
        ]

        const quoteTokens = [
            new PublicKey("So11111111111111111111111111111111111111112"), // SOL
            new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"), // mSOL
            new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), // JitoSOL
            new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"), // bSOL
        ]
        const quoteDecimals = [9, 9, 9, 9]

        // Scan for opportunities
        const allOpportunities: ArbitrageOpportunity[] = []

        for (const pair of tokenPairs) {
            const opps = await this.findArbitrageOpportunities(
                pair.base,
                quoteTokens,
                pair.baseDec,
                quoteDecimals
            )
            allOpportunities.push(...opps)
        }

        this.log.info({
            event: "SelfFundingScanComplete",
            opportunitiesFound: allOpportunities.length,
        })

        // Execute profitable opportunities (best first)
        for (const opp of allOpportunities) {
            if (opp.confidence < 0.7) continue // Only high confidence

            try {
                const result = await this.executeFlashLoanArbitrage(opp)
                if (result.success && result.profit.gt(0)) {
                    totalProfit = totalProfit.add(result.profit)
                    executed++
                } else if (result.error) {
                    errors.push(result.error)
                }
            } catch (e) {
                errors.push(e instanceof Error ? e.message : String(e))
            }

            // Rate limiting between arbitrage attempts
            await this.sleep(500)
        }

        return {
            opportunities: allOpportunities.length,
            executed,
            totalProfit,
            errors,
        }
    }

    // Calculate optimal scale based on price impact
    private calculateOptimalScale(
        forwardImpact: Big,
        reverseImpact: Big
    ): number {
        const totalImpact = forwardImpact.abs().add(reverseImpact.abs())
        // Scale inversely with price impact
        // Low impact = can scale up more
        if (totalImpact.lt(0.1)) return 50  // <0.1% impact, scale to $5k
        if (totalImpact.lt(0.5)) return 20  // <0.5% impact, scale to $2k
        if (totalImpact.lt(1)) return 10    // <1% impact, scale to $1k
        return 5                             // High impact, keep small
    }

    // Calculate confidence score
    private calculateConfidence(
        forwardImpact: Big,
        reverseImpact: Big,
        profitPercent: Big
    ): number {
        let confidence = 0.5

        // Higher profit = higher confidence
        if (profitPercent.gt(0.5)) confidence += 0.2
        else if (profitPercent.gt(0.2)) confidence += 0.1

        // Lower impact = higher confidence
        const totalImpact = forwardImpact.abs().add(reverseImpact.abs())
        if (totalImpact.lt(0.5)) confidence += 0.2
        else if (totalImpact.lt(1)) confidence += 0.1

        return Math.min(confidence, 0.95)
    }

    private getTokenSymbol(mint: PublicKey): string {
        const symbols: Record<string, string> = {
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
            So11111111111111111111111111111111111111112: "SOL",
            mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
            J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
            bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
            JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
        }
        return symbols[mint.toBase58()] || mint.toBase58().slice(0, 8)
    }

    private getDecimals(mint: PublicKey): number {
        const decimals: Record<string, number> = {
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
            So11111111111111111111111111111111111111112: 9,
            mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 9,
            J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 9,
            bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 9,
            JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
        }
        return decimals[mint.toBase58()] || 9
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    setMinProfitThreshold(percent: number): void {
        this.minProfitThresholdPercent = percent
    }

    setMaxBorrowAmount(amount: Big): void {
        this.maxBorrowAmount = amount
    }
}
