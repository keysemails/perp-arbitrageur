import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    VersionedTransaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
    Commitment,
} from "@solana/web3.js"
import {
    getAssociatedTokenAddress,
    getAccount,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import bs58 from "bs58"
import Big from "big.js"
import { Service } from "typedi"
import { Log } from "../Log"

const USDC_DECIMALS = 6
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

@Service()
export class SolanaService {
    private readonly log = Log.getLogger(SolanaService.name)
    private connection!: Connection
    private wallet!: Keypair
    private commitment: Commitment = "confirmed"

    async init(rpcEndpoint: string, privateKey: string): Promise<void> {
        this.connection = new Connection(rpcEndpoint, {
            commitment: this.commitment,
            confirmTransactionInitialTimeout: 60000,
        })

        // Decode private key (supports both base58 and array formats)
        let secretKey: Uint8Array
        try {
            if (privateKey.startsWith("[")) {
                secretKey = Uint8Array.from(JSON.parse(privateKey))
            } else {
                secretKey = bs58.decode(privateKey)
            }
        } catch (e) {
            throw new Error("Invalid private key format. Use base58 or JSON array.")
        }

        this.wallet = Keypair.fromSecretKey(secretKey)

        this.log.info({
            event: "SolanaServiceInitialized",
            wallet: this.wallet.publicKey.toBase58(),
            rpc: rpcEndpoint.replace(/\/\/.*@/, "//***@"), // Hide credentials
        })
    }

    getConnection(): Connection {
        return this.connection
    }

    getWallet(): Keypair {
        return this.wallet
    }

    getPublicKey(): PublicKey {
        return this.wallet.publicKey
    }

    async getSolBalance(): Promise<Big> {
        const balance = await this.connection.getBalance(this.wallet.publicKey)
        return Big(balance).div(LAMPORTS_PER_SOL)
    }

    async getUsdcBalance(): Promise<Big> {
        try {
            const ata = await getAssociatedTokenAddress(
                USDC_MINT,
                this.wallet.publicKey
            )
            const account = await getAccount(this.connection, ata)
            return Big(account.amount.toString()).div(10 ** USDC_DECIMALS)
        } catch (e) {
            // Account doesn't exist = 0 balance
            return Big(0)
        }
    }

    async getTokenBalance(mint: PublicKey, decimals: number): Promise<Big> {
        try {
            const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey)
            const account = await getAccount(this.connection, ata)
            return Big(account.amount.toString()).div(10 ** decimals)
        } catch (e) {
            return Big(0)
        }
    }

    async sendTransaction(transaction: Transaction): Promise<string> {
        const { blockhash, lastValidBlockHeight } =
            await this.connection.getLatestBlockhash(this.commitment)

        transaction.recentBlockhash = blockhash
        transaction.feePayer = this.wallet.publicKey

        const signature = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [this.wallet],
            { commitment: this.commitment }
        )

        this.log.info({
            event: "TransactionSent",
            signature,
        })

        return signature
    }

    async sendVersionedTransaction(transaction: VersionedTransaction): Promise<string> {
        transaction.sign([this.wallet])

        const signature = await this.connection.sendTransaction(transaction, {
            skipPreflight: false,
            preflightCommitment: this.commitment,
            maxRetries: 3,
        })

        const { blockhash, lastValidBlockHeight } =
            await this.connection.getLatestBlockhash(this.commitment)

        await this.connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        }, this.commitment)

        this.log.info({
            event: "VersionedTransactionSent",
            signature,
        })

        return signature
    }

    async getRecentBlockhash(): Promise<string> {
        const { blockhash } = await this.connection.getLatestBlockhash(this.commitment)
        return blockhash
    }

    async getSlot(): Promise<number> {
        return this.connection.getSlot(this.commitment)
    }

    async healthCheck(): Promise<boolean> {
        try {
            const slot = await this.getSlot()
            const solBalance = await this.getSolBalance()

            // Need at least 0.01 SOL for transaction fees
            if (solBalance.lt(0.01)) {
                this.log.warn({
                    event: "LowSolBalance",
                    balance: solBalance.toString(),
                    minimum: "0.01",
                })
                return false
            }

            this.log.debug({
                event: "HealthCheckPassed",
                slot,
                solBalance: solBalance.toString(),
            })

            return true
        } catch (e) {
            this.log.error({
                event: "HealthCheckFailed",
                error: e instanceof Error ? e.message : String(e),
            })
            return false
        }
    }
}

export { USDC_MINT, USDC_DECIMALS }
