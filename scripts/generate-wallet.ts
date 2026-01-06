import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"

// Generate a new Solana wallet
const keypair = Keypair.generate()

console.log("\n" + "=".repeat(60))
console.log("🔑 NEW SOLANA WALLET GENERATED")
console.log("=".repeat(60))
console.log("\nPublic Key (Wallet Address):")
console.log(keypair.publicKey.toBase58())
console.log("\nPrivate Key (Base58 - ADD TO .env.solana):")
console.log(bs58.encode(keypair.secretKey))
console.log("\n" + "=".repeat(60))
console.log("⚠️  IMPORTANT:")
console.log("1. Save this private key securely!")
console.log("2. Add it to .env.solana as SOLANA_PRIVATE_KEY")
console.log("3. Fund this wallet with a tiny amount of SOL for gas (~0.01 SOL)")
console.log("4. The bot will bootstrap itself via flash loans!")
console.log("=".repeat(60) + "\n")
