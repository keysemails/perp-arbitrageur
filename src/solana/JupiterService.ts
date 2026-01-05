import { PublicKey, VersionedTransaction } from "@solana/web3.js"
import Big from "big.js"
import fetch from "node-fetch"
import { Service } from "typedi"
import { URL, URLSearchParams } from "url"
import { Log } from "../Log"
import { SolanaService } from "./SolanaService"

const JUPITER_API_BASE = "https://quote-api.jup.ag/v6"

export interface QuoteResponse {
    inputMint: string
    inAmount: string
    outputMint: string
    outAmount: string
    otherAmountThreshold: string
    swapMode: string
    slippageBps: number
    priceImpactPct: string
    routePlan: RoutePlan[]
    contextSlot: number
    timeTaken: number
}

interface RoutePlan {
    swapInfo: {
        ammKey: string
        label: string
        inputMint: string
        outputMint: string
        inAmount: string
        outAmount: string
        feeAmount: string
        feeMint: string
    }
    percent: number
}

export interface SwapResult {
    signature: string
    inputAmount: Big
    outputAmount: Big
    priceImpact: Big
    route: string[]
}

@Service()
export class JupiterService {
    private readonly log = Log.getLogger(JupiterService.name)
    private solanaService!: SolanaService
    private defaultSlippageBps: number = 50 // 0.5% default slippage

    init(solanaService: SolanaService, slippageBps?: number): void {
        this.solanaService = solanaService
        if (slippageBps !== undefined) {
            this.defaultSlippageBps = slippageBps
        }
        this.log.info({
            event: "JupiterServiceInitialized",
            slippageBps: this.defaultSlippageBps,
        })
    }

    async getQuote(
        inputMint: PublicKey,
        outputMint: PublicKey,
        amount: Big,
        inputDecimals: number,
        slippageBps?: number
    ): Promise<QuoteResponse | null> {
        try {
            const amountLamports = amount.mul(10 ** inputDecimals).toFixed(0)
            const slippage = slippageBps ?? this.defaultSlippageBps

            const params = new URLSearchParams({
                inputMint: inputMint.toBase58(),
                outputMint: outputMint.toBase58(),
                amount: amountLamports,
                slippageBps: slippage.toString(),
                onlyDirectRoutes: "false",
                asLegacyTransaction: "false",
            })

            const response = await fetch(`${JUPITER_API_BASE}/quote?${params}`)

            if (!response.ok) {
                const errorText = await response.text()
                this.log.warn({
                    event: "QuoteFailed",
                    status: response.status,
                    error: errorText,
                })
                return null
            }

            const quote = (await response.json()) as QuoteResponse

            this.log.debug({
                event: "QuoteReceived",
                inputMint: inputMint.toBase58(),
                outputMint: outputMint.toBase58(),
                inAmount: quote.inAmount,
                outAmount: quote.outAmount,
                priceImpact: quote.priceImpactPct,
                routes: quote.routePlan.map((r) => r.swapInfo.label).join(" -> "),
            })

            return quote
        } catch (e) {
            this.log.error({
                event: "QuoteError",
                error: e instanceof Error ? e.message : String(e),
            })
            return null
        }
    }

    async executeSwap(quote: QuoteResponse): Promise<SwapResult | null> {
        try {
            const wallet = this.solanaService.getPublicKey()

            // Get swap transaction
            const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: wallet.toBase58(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: "auto",
                }),
            })

            if (!swapResponse.ok) {
                const errorText = await swapResponse.text()
                this.log.warn({
                    event: "SwapTransactionFailed",
                    status: swapResponse.status,
                    error: errorText,
                })
                return null
            }

            const { swapTransaction } = (await swapResponse.json()) as {
                swapTransaction: string
            }

            // Deserialize and sign
            const transactionBuf = Uint8Array.from(Buffer.from(swapTransaction, "base64"))
            const transaction = VersionedTransaction.deserialize(transactionBuf)

            // Send transaction
            const signature = await this.solanaService.sendVersionedTransaction(
                transaction
            )

            const inputDecimals = this.getDecimalsForMint(quote.inputMint)
            const outputDecimals = this.getDecimalsForMint(quote.outputMint)

            const result: SwapResult = {
                signature,
                inputAmount: Big(quote.inAmount).div(10 ** inputDecimals),
                outputAmount: Big(quote.outAmount).div(10 ** outputDecimals),
                priceImpact: Big(quote.priceImpactPct),
                route: quote.routePlan.map((r) => r.swapInfo.label),
            }

            this.log.info({
                event: "SwapExecuted",
                signature,
                inputMint: quote.inputMint,
                outputMint: quote.outputMint,
                inputAmount: result.inputAmount.toString(),
                outputAmount: result.outputAmount.toString(),
                priceImpact: result.priceImpact.toString(),
            })

            return result
        } catch (e) {
            this.log.error({
                event: "SwapExecutionError",
                error: e instanceof Error ? e.message : String(e),
            })
            return null
        }
    }

    async getPrice(
        inputMint: PublicKey,
        outputMint: PublicKey,
        amount: Big,
        inputDecimals: number,
        outputDecimals: number
    ): Promise<Big | null> {
        const quote = await this.getQuote(inputMint, outputMint, amount, inputDecimals)
        if (!quote) return null

        const inAmount = Big(quote.inAmount).div(10 ** inputDecimals)
        const outAmount = Big(quote.outAmount).div(10 ** outputDecimals)

        return outAmount.div(inAmount)
    }

    async simulateSwap(
        inputMint: PublicKey,
        outputMint: PublicKey,
        amount: Big,
        inputDecimals: number,
        outputDecimals: number
    ): Promise<{ expectedOutput: Big; priceImpact: Big; fee: Big } | null> {
        const quote = await this.getQuote(inputMint, outputMint, amount, inputDecimals)
        if (!quote) return null

        const expectedOutput = Big(quote.outAmount).div(10 ** outputDecimals)
        const priceImpact = Big(quote.priceImpactPct)

        // Calculate total fees from route
        let totalFee = Big(0)
        for (const route of quote.routePlan) {
            const feeDecimals = this.getDecimalsForMint(route.swapInfo.feeMint)
            totalFee = totalFee.add(Big(route.swapInfo.feeAmount).div(10 ** feeDecimals))
        }

        return { expectedOutput, priceImpact, fee: totalFee }
    }

    private getDecimalsForMint(mint: string): number {
        // Common Solana token decimals
        const decimalsMap: Record<string, number> = {
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
            Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
            So11111111111111111111111111111111111111112: 9, // SOL (wrapped)
            mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 9, // mSOL
            "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": 9, // stSOL
            J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 9, // JitoSOL
            bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 9, // bSOL
            DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
            JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6, // JUP
        }
        return decimalsMap[mint] ?? 9 // Default to 9 decimals
    }

    setSlippage(bps: number): void {
        this.defaultSlippageBps = bps
        this.log.info({
            event: "SlippageUpdated",
            slippageBps: bps,
        })
    }
}
