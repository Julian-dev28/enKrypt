import { NetworkNames } from "@enkryptcom/types";
import { Connection, PublicKey } from "@solana/web3.js";
import { toBN } from "web3-utils";
import { TOKEN_AMOUNT_INFINITY_AND_BEYOND } from "../../utils/approvals";
import {
  getSPLAssociatedTokenAccountPubkey,
  getTokenProgramOfMint,
  isValidSolanaAddressAsync,
  solAccountExists,
  SPL_TOKEN_ATA_ACCOUNT_SIZE_BYTES,
  WRAPPED_SOL_ADDRESS,
} from "../../utils/solana";
import {
  ProviderClass,
  ProviderName,
  TokenType,
  SupportedNetworkName,
  ProviderFromTokenResponse,
  ProviderToTokenResponse,
  ProviderSwapResponse,
  SwapQuote,
  StatusOptions,
  TransactionStatus,
  getQuoteOptions,
  ProviderQuoteResponse,
  QuoteMetaOptions,
  TransactionType,
  StatusOptionsResponse,
  SolanaTransaction,
  TokenNetworkType,
  WalletIdentifier,
} from "../../types";
import {
  DEFAULT_SLIPPAGE,
  FEE_CONFIGS,
  NATIVE_TOKEN_ADDRESS,
} from "../../configs";
import { DebugLogger } from "@enkryptcom/utils";
import {
  OKXQuoteResponse,
  OKXSwapParams,
  OKXSwapResponse,
  OKXTokenInfo,
} from "./types";
import CryptoJS from "crypto-js";

const requiredEnvVars = [
  "OKX_API_KEY",
  "OKX_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "OKX_PROJECT_ID",
];

// Helper to get env vars from process.env (Node) or import.meta.env (Vite/browser)
function getEnvVar(name: string): string | undefined {
  logger.info(`getEnvVar(${name}) - checking environment variables`);

  if (typeof process !== "undefined" && process.env && process.env[name]) {
    logger.info(`getEnvVar(${name}) - found in process.env`);
    return process.env[name];
  }

  // For Vite/browser builds, use globalThis.importMetaEnv (set in vite.config.ts)
  if (
    typeof globalThis !== "undefined" &&
    (globalThis as any).importMetaEnv &&
    (globalThis as any).importMetaEnv[`VITE_${name}`]
  ) {
    logger.info(
      `getEnvVar(${name}) - found in globalThis.importMetaEnv.VITE_${name}`,
    );
    return (globalThis as any).importMetaEnv[`VITE_${name}`];
  }

  logger.info(`getEnvVar(${name}) - not found in any environment`);
  return undefined;
}

const logger = new DebugLogger("swap:okx");

const OKX_API_URL = "https://web3.okx.com";
const OKX_TOKENS_URL = "/api/v5/dex/aggregator/all-tokens";
const OKX_QUOTE_URL = "/api/v5/dex/aggregator/quote";
const OKX_SWAP_URL = "/api/v5/dex/aggregator/swap";

// Rate limiting: minimum 2000ms between requests (increased from 500ms)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // ms (increased from 500ms)
let requestCount = 0;

// Helper to enforce rate limiting
async function rateLimitedRequest(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const delay = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    logger.info(`Rate limiting: waiting ${delay}ms before next request`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
  requestCount++;
  logger.info(
    `OKX API request #${requestCount} at ${new Date().toISOString()}`,
  );
}

// Helper to retry requests with exponential backoff
async function retryRequest<T>(
  requestFn: () => Promise<T>,
  maxRetries: number = 5,
  baseDelay: number = 2000,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimitedRequest();
      logger.info(`OKX API attempt ${attempt + 1}/${maxRetries + 1}`);
      return await requestFn();
    } catch (error: any) {
      lastError = error;

      // If it's a 429 error and we haven't exhausted retries, wait and retry
      if (
        error.message?.includes("429") ||
        error.message?.includes("Too Many Requests")
      ) {
        let delay = baseDelay * Math.pow(2, attempt); // exponential backoff
        // Check for Retry-After header if available
        if (error.response && error.response.headers) {
          const retryAfter =
            error.response.headers.get &&
            error.response.headers.get("Retry-After");
          if (retryAfter) {
            const retryAfterMs = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(retryAfterMs)) {
              delay = Math.max(delay, retryAfterMs);
              logger.info(
                `OKX API Retry-After header present, waiting ${delay}ms`,
              );
            }
          }
        }
        if (attempt < maxRetries) {
          logger.info(
            `OKX API rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // For other errors or if we've exhausted retries, throw the error
      logger.error(
        `OKX API request failed after ${attempt + 1} attempts: ${error.message}`,
      );
      throw error;
    }
  }

  throw lastError!;
}

/**
 * OKX DEX Aggregator Provider
 *
 * Implements swap functionality using OKX's DEX aggregator API
 * @see https://web3.okx.com/docs-v5/en/#rest-api-trading-get-token-list
 */
export class OKX extends ProviderClass {
  network: SupportedNetworkName;
  name = ProviderName.okx;
  conn: Connection;

  /** Initialised in `init` */
  fromTokens: ProviderFromTokenResponse;

  /** initialised in `init` */
  toTokens: ProviderToTokenResponse;

  /** Initialised in `init` address -> OKX token info */
  okxTokens: Map<string, OKXTokenInfo>;

  constructor(conn: Connection, network: SupportedNetworkName) {
    super();
    this.network = network;
    this.conn = conn;

    this.fromTokens = {};
    this.toTokens = {};
    this.okxTokens = new Map();
  }

  /**
   * Initialize the provider with token list
   */
  async init(enkryptTokenList: TokenType[]): Promise<void> {
    // Only supports Solana
    if ((this.network as unknown as string) !== NetworkNames.Solana) return;

    // Check environment variables before making API calls
    this.checkEnvironmentVariables();

    // Get OKX token list
    const okxTokenList = await this.getOKXTokens();

    // Initialize token mappings
    this.toTokens[this.network] ??= {};
    this.okxTokens = new Map(
      okxTokenList.map((t) => [t.tokenContractAddress, t]),
    );

    for (const enkryptToken of enkryptTokenList) {
      let isTradeable = false;
      if (enkryptToken.address === NATIVE_TOKEN_ADDRESS) {
        // OKX swap API auto unwraps SOL
        isTradeable = this.okxTokens.has(WRAPPED_SOL_ADDRESS);
      } else {
        isTradeable = this.okxTokens.has(enkryptToken.address);
      }

      // Not supported
      if (!isTradeable) continue;

      // Add token to fromTokens
      this.fromTokens[enkryptToken.address] = enkryptToken;

      // Add token to toTokens with network info
      this.toTokens[this.network][enkryptToken.address] = {
        ...enkryptToken,
        networkInfo: {
          name: SupportedNetworkName.Solana,
          isAddress: isValidSolanaAddressAsync,
        } satisfies TokenNetworkType,
      };
    }
  }

  getFromTokens(): ProviderFromTokenResponse {
    return this.fromTokens;
  }

  getToTokens(): ProviderToTokenResponse {
    return this.toTokens;
  }

  /**
   * Get a quote for swapping tokens
   */
  async getQuote(
    options: getQuoteOptions,
    meta: QuoteMetaOptions,
    context?: { signal?: AbortSignal },
  ): Promise<ProviderQuoteResponse | null> {
    try {
      if (!meta || !meta.walletIdentifier) {
        console.warn(
          "[OKX.getQuote] meta or meta.walletIdentifier is missing, using WalletIdentifier.enkrypt as fallback:",
          meta,
        );
        meta = { ...meta, walletIdentifier: WalletIdentifier.enkrypt };
      }
      if (options.toToken.networkInfo.name !== SupportedNetworkName.Solana) {
        logger.info(
          `getQuote: ignoring quote request to network ${options.toToken.networkInfo.name},` +
            ` cross network swaps not supported`,
        );
        return null;
      }

      const feeConf = FEE_CONFIGS[this.name][meta.walletIdentifier];
      if (!feeConf) {
        throw new Error("Something went wrong: no fee config for OKX swap");
      }

      const toPubkey = new PublicKey(options.toAddress);

      // Source token
      let srcMint: PublicKey;
      if (options.fromToken.address === NATIVE_TOKEN_ADDRESS) {
        srcMint = new PublicKey(WRAPPED_SOL_ADDRESS);
      } else {
        srcMint = new PublicKey(options.fromToken.address);
      }

      // Destination token
      let dstMint: PublicKey;
      if (options.toToken.address === NATIVE_TOKEN_ADDRESS) {
        dstMint = new PublicKey(WRAPPED_SOL_ADDRESS);
      } else {
        dstMint = new PublicKey(options.toToken.address);
      }

      // Get quote from OKX API
      const quote = await this.getOKXQuote(
        {
          srcMint,
          dstMint,
          amount: BigInt(options.amount.toString(10)),
          slippageBps: Math.round(
            100 * parseFloat(meta.slippage || DEFAULT_SLIPPAGE),
          ),
          referralFeeBps: Math.round(10000 * feeConf.fee),
        },
        context,
      );

      // Calculate compute budget and rent fees
      const dstTokenProgramId = await getTokenProgramOfMint(this.conn, dstMint);
      const dstATAPubkey = getSPLAssociatedTokenAccountPubkey(
        toPubkey,
        dstMint,
        dstTokenProgramId,
      );

      let rentFees = 0;
      try {
        const dstATAExists = await solAccountExists(this.conn, dstATAPubkey);
        if (!dstATAExists) {
          const extraRentFee =
            await this.conn.getMinimumBalanceForRentExemption(
              SPL_TOKEN_ATA_ACCOUNT_SIZE_BYTES,
            );
          rentFees += extraRentFee;
        }
      } catch (error) {
        // If we can't check if the account exists (RPC timeout), assume it doesn't exist
        // and add rent fees as a safety measure
        logger.warn(
          `Could not check if destination token account exists: ${error}`,
        );
        try {
          const extraRentFee =
            await this.conn.getMinimumBalanceForRentExemption(
              SPL_TOKEN_ATA_ACCOUNT_SIZE_BYTES,
            );
          rentFees += extraRentFee;
        } catch (rentError) {
          logger.warn(`Could not get rent exemption: ${rentError}`);
          // Use a default rent fee if we can't get it
          rentFees += 2039280; // Default SOL rent exemption for token account
        }
      }

      logger.info(
        `getQuote: Quote inAmount: ${quote.fromTokenAmount} ${options.fromToken.symbol}`,
      );
      logger.info(
        `getQuote: Quote outAmount: ${quote.toTokenAmount} ${options.toToken.symbol}`,
      );

      return {
        fromTokenAmount: toBN(quote.fromTokenAmount),
        toTokenAmount: toBN(
          Math.floor((1 - feeConf.fee) * Number(quote.toTokenAmount))
            .toFixed(10)
            .replace(/\.?0+$/, ""),
        ),
        totalGaslimit: 0, // Will be set in getSwap
        additionalNativeFees: toBN(rentFees),
        provider: this.name,
        quote: {
          options,
          meta,
          provider: this.name,
        },
        minMax: {
          minimumFrom: toBN("1"),
          maximumFrom: toBN(TOKEN_AMOUNT_INFINITY_AND_BEYOND),
          minimumTo: toBN("1"),
          maximumTo: toBN(TOKEN_AMOUNT_INFINITY_AND_BEYOND),
        },
      };
    } catch (err) {
      if (!context?.signal?.aborted) {
        console.error(`[OKX.getQuote] Error calling getQuote: ${String(err)}`);
      }
      return null;
    }
  }

  /**
   * Get swap transaction details
   */
  async getSwap(
    quote: SwapQuote,
    context?: { signal?: AbortSignal },
  ): Promise<ProviderSwapResponse | null> {
    try {
      const { feePercentage, okxQuote, base64SwapTransaction, rentFees } =
        await this.querySwapInfo(quote.options, quote.meta, context);

      const enkryptTransaction: SolanaTransaction = {
        from: quote.options.fromAddress,
        to: quote.options.toAddress,
        serialized: base64SwapTransaction,
        type: TransactionType.solana,
        kind: "versioned",
        thirdPartySignatures: [],
      };

      logger.info(
        `getSwap: Quote inAmount:  ${okxQuote.fromTokenAmount} ${quote.options.fromToken.symbol}`,
      );
      logger.info(
        `getSwap: Quote outAmount: ${okxQuote.toTokenAmount} ${quote.options.toToken.symbol}`,
      );

      return {
        transactions: [enkryptTransaction],
        fromTokenAmount: toBN(okxQuote.fromTokenAmount),
        toTokenAmount: toBN(
          Math.floor((1 - feePercentage / 100) * Number(okxQuote.toTokenAmount))
            .toFixed(10)
            .replace(/\.?0+$/, ""),
        ),
        additionalNativeFees: toBN(rentFees),
        provider: this.name,
        slippage: quote.meta.slippage,
        fee: feePercentage,
        getStatusObject: async (
          options: StatusOptions,
        ): Promise<StatusOptionsResponse> => ({
          options,
          provider: this.name,
        }),
      };
    } catch (err) {
      if (!context?.signal?.aborted) {
        console.error(`[OKX.getSwap] Error calling getSwap: ${String(err)}`);
      }
      return null;
    }
  }

  /**
   * Get transaction status
   */
  async getStatus(options: StatusOptions): Promise<TransactionStatus> {
    if (options.transactions.length !== 1) {
      throw new TypeError(
        `OKX.getStatus: Expected one transaction hash but got ${options.transactions.length}`,
      );
    }

    const [{ sentAt, hash }] = options.transactions;
    const txResponse = await this.conn.getTransaction(hash, {
      maxSupportedTransactionVersion: 0,
    });

    if (txResponse == null) {
      // Consider dropped (/failed) if it's still null after 3 minutes
      if (Date.now() > sentAt + 3 * 60_000) {
        return TransactionStatus.dropped;
      }

      // Transaction hasn't been picked up by the node yet
      return TransactionStatus.pending;
    }

    if (txResponse.meta == null) {
      return TransactionStatus.pending;
    }

    if (txResponse.meta.err != null) {
      return TransactionStatus.failed;
    }

    return TransactionStatus.success;
  }

  /**
   * Get list of tokens from OKX API
   */
  private async getOKXTokens(): Promise<OKXTokenInfo[]> {
    return retryRequest(async () => {
      const params = {
        chainId: "501", // Solana Chain ID
      };

      const timestamp = new Date().toISOString();
      const requestPath = OKX_TOKENS_URL;
      const queryString = "?" + new URLSearchParams(params).toString();
      const headers = this.getHeaders(
        timestamp,
        "GET",
        requestPath,
        queryString,
      );

      const response = await fetch(
        `${OKX_API_URL}${requestPath}${queryString}`,
        {
          method: "GET",
          headers,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to get OKX tokens: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      return data.data;
    });
  }

  /**
   * Get quote from OKX API
   */
  private async getOKXQuote(
    params: {
      srcMint: PublicKey;
      dstMint: PublicKey;
      amount: bigint;
      slippageBps: number;
      referralFeeBps: number;
    },
    context?: { signal?: AbortSignal },
  ): Promise<OKXQuoteResponse> {
    return retryRequest(async () => {
      const { srcMint, dstMint, amount, slippageBps, referralFeeBps } = params;

      const quoteParams = {
        chainId: "501", // Solana Chain ID
        fromTokenAddress: srcMint.toBase58(),
        toTokenAddress: dstMint.toBase58(),
        amount: amount.toString(10),
        slippage: (slippageBps / 100).toString(),
        feePercent: (referralFeeBps / 100).toString(),
        swapMode: "exactIn",
      };

      const timestamp = new Date().toISOString();
      const requestPath = OKX_QUOTE_URL;
      const queryString = "?" + new URLSearchParams(quoteParams).toString();
      const headers = this.getHeaders(
        timestamp,
        "GET",
        requestPath,
        queryString,
      );

      const response = await fetch(
        `${OKX_API_URL}${requestPath}${queryString}`,
        {
          method: "GET",
          headers,
          signal: context?.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to get OKX quote: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      return data.data[0];
    });
  }

  /**
   * Get swap transaction from OKX API
   */
  private async getOKXSwap(
    params: OKXSwapParams,
    context?: { signal?: AbortSignal },
  ): Promise<OKXSwapResponse> {
    return retryRequest(async () => {
      const timestamp = new Date().toISOString();
      const requestPath = OKX_SWAP_URL;
      const queryString = "?" + new URLSearchParams(params as any).toString();
      const headers = this.getHeaders(
        timestamp,
        "GET",
        requestPath,
        queryString,
      );

      console.log(
        `OKX: Making swap API call to: ${OKX_API_URL}${requestPath}${queryString}`,
      );
      console.log(`OKX: Headers:`, headers);

      const response = await fetch(
        `${OKX_API_URL}${requestPath}${queryString}`,
        {
          method: "GET",
          headers,
          signal: context?.signal,
        },
      );

      logger.info(
        `OKX: Response status: ${response.status} ${response.statusText}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`OKX: API error response:`, errorText);
        throw new Error(
          `Failed to get OKX swap: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      logger.info(`OKX: Raw API response:`, data);
      logger.info(
        `OKX Swap API Response Debug:`,
        JSON.stringify(data, null, 2),
      );

      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        logger.error(`OKX: Invalid response structure:`, data);
        throw new Error(`Invalid OKX API response structure`);
      }

      const swapData = data.data[0];
      logger.info(`OKX: Swap data:`, swapData);

      if (!swapData || !swapData.tx) {
        logger.error(`OKX: Missing tx in swap data:`, swapData);
        throw new Error(`Missing tx in OKX swap response`);
      }

      return swapData;
    });
  }

  /**
   * Check if required environment variables are available
   */
  private checkEnvironmentVariables(): void {
    const missingVars = requiredEnvVars.filter((v) => !getEnvVar(v));
    if (missingVars.length > 0) {
      throw new Error(
        `Missing required OKX environment variables: ${missingVars.join(", ")}`,
      );
    }
  }

  /**
   * Generate headers for OKX API requests
   */
  private getHeaders(
    timestamp: string,
    method: string,
    requestPath: string,
    queryString: string,
  ): HeadersInit {
    // Check environment variables when actually making API calls
    this.checkEnvironmentVariables();

    const apiKey = getEnvVar("OKX_API_KEY");
    const secretKey = getEnvVar("OKX_SECRET_KEY");
    const apiPassphrase = getEnvVar("OKX_API_PASSPHRASE");
    const projectId = getEnvVar("OKX_PROJECT_ID");

    // Debug: Log what we're getting
    logger.info(
      `OKX Headers Debug - API Key: ${apiKey ? "present" : "missing"}, Secret: ${secretKey ? "present" : "missing"}, Passphrase: ${apiPassphrase ? "present" : "missing"}, Project ID: ${projectId ? "present" : "missing"}`,
    );

    if (!apiKey || !secretKey || !apiPassphrase || !projectId) {
      throw new Error("Missing required environment variables");
    }

    const stringToSign = timestamp + method + requestPath + queryString;
    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": CryptoJS.enc.Base64.stringify(
        CryptoJS.HmacSHA256(stringToSign, secretKey),
      ),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": apiPassphrase,
      "OK-ACCESS-PROJECT": projectId,
    };
  }

  /**
   * Query swap info from OKX API
   */
  private async querySwapInfo(
    options: getQuoteOptions,
    meta: QuoteMetaOptions,
    context?: { signal?: AbortSignal },
  ): Promise<{
    okxQuote: OKXQuoteResponse;
    base64SwapTransaction: string;
    feePercentage: number;
    rentFees: number;
  }> {
    if (!meta || !meta.walletIdentifier) {
      logger.warn(
        "[OKX.querySwapInfo] meta or meta.walletIdentifier is missing, using WalletIdentifier.enkrypt as fallback:",
        meta,
      );
      meta = { ...meta, walletIdentifier: WalletIdentifier.enkrypt };
    }
    const feeConf = FEE_CONFIGS[this.name][meta.walletIdentifier];
    if (!feeConf) {
      throw new Error("Something went wrong: no fee config for OKX swap");
    }

    const fromPubkey = new PublicKey(options.fromAddress);
    const toPubkey = new PublicKey(options.toAddress);

    // Source token
    let srcMint: PublicKey;
    if (options.fromToken.address === NATIVE_TOKEN_ADDRESS) {
      srcMint = new PublicKey(WRAPPED_SOL_ADDRESS);
    } else {
      srcMint = new PublicKey(options.fromToken.address);
    }

    // Destination token
    let dstMint: PublicKey;
    if (options.toToken.address === NATIVE_TOKEN_ADDRESS) {
      dstMint = new PublicKey(WRAPPED_SOL_ADDRESS);
    } else {
      dstMint = new PublicKey(options.toToken.address);
    }

    // Get quote
    const quote = await this.getOKXQuote(
      {
        srcMint,
        dstMint,
        amount: BigInt(options.amount.toString(10)),
        slippageBps: Math.round(
          5 * parseFloat(meta.slippage || DEFAULT_SLIPPAGE),
        ),
        referralFeeBps: Math.round(10000 * feeConf.fee),
      },
      context,
    );

    // Get swap transaction
    logger.info(`OKX: About to call getOKXSwap with params:`, {
      chainId: "501",
      amount: options.amount.toString(10),
      swapMode: "exactIn",
      fromTokenAddress: srcMint.toBase58(),
      toTokenAddress: dstMint.toBase58(),
      slippage: (
        Math.round(5 * parseFloat(meta.slippage || DEFAULT_SLIPPAGE)) / 100
      ).toString(),
      userWalletAddress: fromPubkey.toBase58(),
      feePercent: (Math.round(10000 * feeConf.fee) / 100).toString(),
      autoSlippage: false,
      maxAutoSlippage: "50",
      fromReferrerAddress: fromPubkey.toBase58(),
      toTokenReferrerAddress: toPubkey.toBase58(),
    });

    const swap = await this.getOKXSwap(
      {
        chainId: "501",
        amount: options.amount.toString(10),
        swapMode: "exactIn",
        fromTokenAddress: srcMint.toBase58(),
        toTokenAddress: dstMint.toBase58(),
        slippage: (
          Math.round(5 * parseFloat(meta.slippage || DEFAULT_SLIPPAGE)) / 100
        ).toString(),
        userWalletAddress: fromPubkey.toBase58(),
        feePercent: (Math.round(10000 * feeConf.fee) / 100).toString(),
        autoSlippage: false,
        maxAutoSlippage: "50",
        fromReferrerAddress: fromPubkey.toBase58(),
        toTokenReferrerAddress: toPubkey.toBase58(),
      },
      context,
    );

    // Debug: Log the swap response structure
    logger.info(`OKX Swap Response Debug:`, swap);
    logger.info(`OKX Swap Response Debug:`, JSON.stringify(swap, null, 2));

    // Calculate rent fees
    const dstTokenProgramId = await getTokenProgramOfMint(this.conn, dstMint);
    const dstATAPubkey = getSPLAssociatedTokenAccountPubkey(
      toPubkey,
      dstMint,
      dstTokenProgramId,
    );

    let rentFees = 0;
    try {
      const dstATAExists = await solAccountExists(this.conn, dstATAPubkey);
      if (!dstATAExists) {
        const extraRentFee = await this.conn.getMinimumBalanceForRentExemption(
          SPL_TOKEN_ATA_ACCOUNT_SIZE_BYTES,
        );
        rentFees += extraRentFee;
      }
    } catch (error) {
      // If we can't check if the account exists (RPC timeout), assume it doesn't exist
      // and add rent fees as a safety measure
      logger.warn(
        `Could not check if destination token account exists: ${error}`,
      );
      try {
        const extraRentFee = await this.conn.getMinimumBalanceForRentExemption(
          SPL_TOKEN_ATA_ACCOUNT_SIZE_BYTES,
        );
        rentFees += extraRentFee;
      } catch (rentError) {
        logger.warn(`Could not get rent exemption: ${rentError}`);
        // Use a default rent fee if we can't get it
        rentFees += 2039280; // Default SOL rent exemption for token account
      }
    }

    logger.info(`OKX: About to access swap.tx.data`);
    logger.info(`OKX: swap object:`, swap);
    logger.info(`OKX: swap.tx:`, swap.tx);
    logger.info(`OKX: swap.tx.data length:`, swap.tx.data?.length);
    logger.info(
      `OKX: swap.tx.data (first 100 chars):`,
      swap.tx.data?.substring(0, 100),
    );

    if (!swap.tx) {
      logger.error(`OKX: swap.tx is undefined!`);
      throw new Error(`Missing tx in swap response`);
    }

    if (!swap.tx.data) {
      logger.error(`OKX: swap.tx.data is undefined!`);
      throw new Error(`Missing tx.data in swap response`);
    }

    // Check if the transaction data looks valid
    if (swap.tx.data.length < 100) {
      logger.warn(`OKX: Transaction data seems very short:`, swap.tx.data);
      // Continue anyway
    }

    // Validate that the transaction data is valid base64
    try {
      Buffer.from(swap.tx.data, "base64");
    } catch (error) {
      logger.error(`OKX: Invalid base64 transaction data:`, error);
      throw new Error(`Invalid base64 transaction data from OKX API`);
    }

    // Log transaction data info for debugging
    const decodedData = Buffer.from(swap.tx.data, "base64");
    logger.info(`OKX: Transaction data length: ${decodedData.length} bytes`);
    logger.info(
      `OKX: Transaction data (first 50 bytes):`,
      decodedData.subarray(0, 50),
    );

    // Try to deserialize the transaction to validate it (like Jupiter does)
    try {
      const { VersionedTransaction } = await import("@solana/web3.js");
      VersionedTransaction.deserialize(decodedData);
      logger.info(`OKX: Transaction data is valid versioned transaction`);
    } catch (deserializeError) {
      logger.warn(
        `OKX: Transaction data could not be deserialized: ${deserializeError.message}`,
      );
      // Continue anyway, pass through whatever data we got
      logger.info(
        `OKX: Proceeding with transaction data despite deserialization failure`,
      );
    }

    return {
      okxQuote: quote,
      base64SwapTransaction: swap.tx.data,
      feePercentage: feeConf.fee * 100,
      rentFees,
    };
  }
}
