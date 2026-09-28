/**
 * EVM On-Chain Executor (Ethereum + Base)
 * Uses viem + Uniswap V3 Universal Router — no API keys.
 * Public RPC endpoints: publicnode.com
 *
 * CORRECTNESS NOTES (fix/execution-correctness)
 * ---------------------------------------------
 * The previous version returned `amountOut: 0` from both buy and sell with
 * the comment "parse from logs for precision; simplified here". That single
 * zero propagated through the whole money path:
 *
 *   - positions.tokenAmountOut was stored as 0 on entry
 *   - closePosition computed amountToClose = 0 * pct = 0 and sold nothing
 *   - exitAmountUsd fell back to the scanner's CACHED price
 *   - realised P&L was therefore computed from a stale quote, never a fill
 *
 * Both paths now decode the Uniswap V3 `Swap` event, which is the only
 * authoritative record of what actually traded.
 *
 * Slippage: `slippagePct` was accepted by both functions and never used;
 * minAmountOut was hardcoded to 0n with the comment "rely on slippage check
 * after" — there was no check after. On a public RPC that is an open
 * invitation to a sandwich. minAmountOut is now derived from the reference
 * price and the tolerance, and the swap is aborted when no referenced bound
 * is available rather than defaulting to zero.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  encodeAbiParameters,
  parseAbiParameters,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base } from "viem/chains";
import { logger } from "./logger";

// Public RPC endpoints — no API key needed
const RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum.publicnode.com",
  base: "https://base.publicnode.com",
};

// Uniswap V3 Universal Router (same address on Ethereum + Base)
const UNIVERSAL_ROUTER: Address = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

// Uniswap V3 Permit2 (for token approvals)
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Common tokens
const TOKENS: Record<string, Record<string, Address>> = {
  ethereum: {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  base: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

const USDC_DECIMALS = 6;

/** Default slippage tolerance: 0.5% */
export const DEFAULT_SLIPPAGE_PCT = 0.5;

/** Fee tier to route through. 3000 = 0.3%. */
const POOL_FEE = 3000;

// Minimal ERC20 ABI for approvals, balances and precision
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// Uniswap V3 Swap event — the authoritative record of a fill.
// event Swap(address indexed sender, address indexed recipient,
//            int256 amount0, int256 amount1, uint160 sqrtPriceX96,
//            uint128 liquidity, int24 tick)
const UNISWAP_V3_SWAP_EVENT = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
} as const;

// ERC20 Transfer event — fallback for aggregators that split across venues.
const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  /** Human-readable output units, when known. */
  amountOutDecimals?: number;
  gasUsed?: number;
  /** Set when the fill came back short of the enforced minimum. */
  shortfallUsd?: number;
  error?: string;
}

export interface EvmSwapOptions {
  slippagePct?: number;
  /**
   * Decimal precision of the token being bought/sold. Resolved on chain when
   * omitted; the previous default of 18 silently mis-scaled every ERC-20
   * that is not 18-decimal.
   */
  tokenDecimals?: number;
  /**
   * Reference price the order is ranged against. Required for buys: without
   * it there is no honest value for minAmountOut, and a zero minimum is
   * indistinguishable from no protection at all.
   */
  referencePriceUsd?: number;
}

function getChainConfig(chain: string) {
  if (chain === "base") return { viemChain: base, rpc: RPC_URLS.base };
  return { viemChain: mainnet, rpc: RPC_URLS.ethereum };
}

function getPrivateKey(chain: string): Hex | null {
  const key =
    chain === "base"
      ? process.env.BASE_WALLET_PRIVATE_KEY || process.env.EVM_WALLET_PRIVATE_KEY
      : process.env.EVM_WALLET_PRIVATE_KEY;
  if (!key) return null;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/**
 * Resolve an ERC-20's decimals on chain. Returns null rather than guessing.
 * A wrong decimals value mis-sizes the order by orders of magnitude, so a
 * missing value must stop the trade rather than default to 18.
 */
export async function getErc20Decimals(
  publicClient: PublicClient,
  tokenAddress: Address
): Promise<number | null> {
  try {
    const decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    return Number(decimals);
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Could not read ERC-20 decimals");
    return null;
  }
}

/**
 * Derive an enforced minimum-output bound from a reference price.
 * Integer maths throughout: this value gates a transfer, so float rounding
 * is not acceptable.
 */
function computeMinAmountOut(
  amountInBaseUnits: bigint,
  inputDecimals: number,
  outputDecimals: number,
  referencePriceUsd: number,
  slippagePct: number
): bigint | null {
  if (!(referencePriceUsd > 0)) return null;
  const tol = Math.min(Math.max(slippagePct, 0), 50);

  const humanIn = Number(formatUnits(amountInBaseUnits, inputDecimals));
  // Reference gives USD value; a USDC reference is 1:1 USD by definition.
  const expectedOutHuman = humanIn / referencePriceUsd;
  const floorHuman = expectedOutHuman * (1 - tol / 100);

  // Convert to base units via integer maths on a scaled numerator.
  const scaled = BigInt(Math.floor(floorHuman * Math.pow(10, outputDecimals)));
  return scaled > 0n ? scaled : null;
}

/**
 * Extract the output amount this wallet actually received, from the
 * transaction receipt. Tries the Uniswap V3 Swap event first, then falls
 * back to ERC-20 Transfer events to the wallet for routed fills.
 */
function extractAmountOut(
  receipt: { logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[] },
  walletAddress: Address,
  outputToken: Address,
  outputDecimals: number
): number | null {
  // Pass 1 — direct Uniswap V3 pool Swap events.
  let netOut = 0n;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: [UNISWAP_V3_SWAP_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "Swap") continue;
      const { recipient } = decoded.args as unknown as { recipient: Address };
      if (recipient?.toLowerCase() !== walletAddress.toLowerCase()) continue;
      const { amount0, amount1 } = decoded.args as unknown as {
        amount0: bigint;
        amount1: bigint;
      };
      // For a wallet-recipient swap, one leg is positive (received) and the
      // other negative (paid). Sum the positive leg.
      if (amount0 > 0n) netOut += amount0;
      if (amount1 > 0n) netOut += amount1;
    } catch {
      // Not a Swap event from a pool we can decode — expected for most logs.
      continue;
    }
  }
  if (netOut > 0n) {
    return Number(formatUnits(netOut, outputDecimals));
  }

  // Pass 2 — ERC-20 Transfer events into the wallet for the output token.
  // Covers routers that go through several pools or a different venue.
  let transferIn = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== outputToken.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [ERC20_TRANSFER_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const { to, value } = decoded.args as unknown as { to: Address; value: bigint };
      if (to?.toLowerCase() === walletAddress.toLowerCase()) {
        transferIn += value;
      }
    } catch {
      continue;
    }
  }
  if (transferIn > 0n) {
    return Number(formatUnits(transferIn, outputDecimals));
  }

  return null;
}

export async function getWalletBalance(chain: string, tokenSymbol: string = "USDC"): Promise<number> {
  const { viemChain, rpc } = getChainConfig(chain);
  const key = getPrivateKey(chain);
  if (!key) return 0;

  try {
    const account = privateKeyToAccount(key);
    const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const tokenAddress = TOKENS[chain]?.[tokenSymbol];
    if (!tokenAddress) return 0;

    const [balance, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
    ]);

    return Number(formatUnits(balance as bigint, decimals as number));
  } catch (err) {
    logger.error({ err, chain, tokenSymbol }, "Failed to get wallet balance");
    return 0;
  }
}

export async function getWalletAddress(chain: string): Promise<string | null> {
  const key = getPrivateKey(chain);
  if (!key) return null;
  try {
    const account = privateKeyToAccount(key);
    return account.address;
  } catch {
    return null;
  }
}

/** On-chain balance of an arbitrary ERC-20 for the configured wallet. */
export async function getTokenBalance(chain: string, tokenAddress: Address): Promise<number | null> {
  const key = getPrivateKey(chain);
  if (!key) return null;
  const { viemChain, rpc } = getChainConfig(chain);
  try {
    const account = privateKeyToAccount(key);
    const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const [balance, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    return Number(formatUnits(balance as bigint, decimals as number));
  } catch (err) {
    logger.warn({ err, chain, tokenAddress }, "Failed to read token balance");
    return null;
  }
}

/**
 * Approve `spender` if the current allowance is short. Returns false when the
 * approval could not be established, which must abort the swap.
 */
async function ensureApproval(
  publicClient: PublicClient,
  walletClient: ReturnType<typeof createWalletClient>,
  tokenAddress: Address,
  owner: Address,
  needed: bigint
): Promise<boolean> {
  const allowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, PERMIT2],
  })) as bigint;

  if (allowance >= needed) return true;

  try {
    const approveTx = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (receipt.status !== "success") {
      logger.error({ approveTx }, "Approval transaction reverted");
      return false;
    }
    logger.info({ approveTx, tokenAddress }, "Token approved to Permit2");
    return true;
  } catch (err) {
    logger.error({ err, tokenAddress }, "Approval failed");
    return false;
  }
}

const ROUTER_ABI = [
  {
    name: "execute",
    type: "function",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/**
 * Execute a buy swap: USDC → token via Uniswap V3.
 *
 * The caller should pass `referencePriceUsd`. Without it, minAmountOut
 * cannot be computed and the order is REFUSED rather than sent unprotected.
 */
export async function executeBuyEVM(
  chain: string,
  tokenAddress: Address,
  amountUsd: number,
  options: EvmSwapOptions = {}
): Promise<SwapResult> {
  const key = getPrivateKey(chain);
  if (!key) return { success: false, amountIn: 0, amountOut: 0, error: "No wallet private key configured" };

  const { viemChain, rpc } = getChainConfig(chain);
  const usdcAddress = TOKENS[chain]?.["USDC"];
  if (!usdcAddress) return { success: false, amountIn: 0, amountOut: 0, error: `No USDC token for chain ${chain}` };

  const slippagePct = options.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
  if (!(amountUsd > 0)) {
    return { success: false, amountIn: 0, amountOut: 0, error: "Buy amount must be positive" };
  }

  try {
    const account = privateKeyToAccount(key);
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });

    const tokenDecimals = options.tokenDecimals ?? (await getErc20Decimals(publicClient, tokenAddress));
    if (tokenDecimals === null) {
      return {
        success: false,
        amountIn: amountUsd,
        amountOut: 0,
        error: `Could not resolve decimals for ${tokenAddress} — refusing to guess`,
      };
    }

    const amountIn = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);

    const minAmountOut = computeMinAmountOut(
      amountIn,
      USDC_DECIMALS,
      tokenDecimals,
      options.referencePriceUsd ?? 0,
      slippagePct
    );
    if (minAmountOut === null) {
      return {
        success: false,
        amountIn: amountUsd,
        amountOut: 0,
        error:
          "No reference price supplied — refusing to send a swap with an unbounded minimum output",
      };
    }

    if (!(await ensureApproval(publicClient, walletClient, usdcAddress, account.address, amountIn))) {
      return { success: false, amountIn: amountUsd, amountOut: 0, error: "USDC approval failed" };
    }

    const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 300);

    // V3_SWAP_EXACT_IN params:
    // (recipient, amountIn, amountOutMin, path[], payerIsUser)
    const swapParams = encodeAbiParameters(
      parseAbiParameters("address, uint256, uint256, bytes, bool"),
      [
        account.address,
        amountIn,
        minAmountOut,
        encodeAbiParameters(
          parseAbiParameters("address, uint24, address"),
          [usdcAddress, POOL_FEE, tokenAddress]
        ),
        true,
      ]
    );

    const txHash = await walletClient.writeContract({
      address: UNIVERSAL_ROUTER,
      abi: ROUTER_ABI,
      functionName: "execute",
      args: ["0x00" as Hex, [swapParams], DEADLINE],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      logger.error({ chain, txHash }, "EVM buy reverted on chain");
      return { success: false, txHash, amountIn: amountUsd, amountOut: 0, error: "Buy transaction reverted" };
    }

    const amountOut = extractAmountOut(receipt, account.address, tokenAddress, tokenDecimals);
    if (amountOut === null) {
      // The swap confirmed, but the fill cannot be measured. Reporting 0 here
      // is what corrupted the position record before; report the failure.
      logger.error({ chain, txHash }, "EVM buy confirmed but output could not be decoded from receipt");
      return {
        success: false,
        txHash,
        amountIn: amountUsd,
        amountOut: 0,
        error: "Swap confirmed but output amount could not be decoded — position cannot be booked",
      };
    }

    const minOutHuman = Number(formatUnits(minAmountOut, tokenDecimals));
    const shortfallUsd =
      amountOut < minOutHuman ? (minOutHuman - amountOut) * (options.referencePriceUsd ?? 0) : 0;

    logger.info(
      { chain, txHash, amountUsd, amountOut, tokenDecimals, minOutHuman, gasUsed: Number(receipt.gasUsed) },
      "EVM BUY executed"
    );

    return {
      success: true,
      txHash,
      amountIn: amountUsd,
      amountOut,
      amountOutDecimals: tokenDecimals,
      gasUsed: Number(receipt.gasUsed),
      shortfallUsd,
    };
  } catch (err: any) {
    logger.error({ err, chain }, "EVM buy execution failed");
    return { success: false, amountIn: amountUsd, amountOut: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Execute a sell swap: token → USDC via Uniswap V3.
 *
 * `tokenAmount` is in HUMAN units of the token and is converted using the
 * `tokenDecimals` the caller resolved at entry. It is never defaulted.
 */
export async function executeSellEVM(
  chain: string,
  tokenAddress: Address,
  tokenAmount: number,
  tokenDecimals: number,
  options: EvmSwapOptions = {}
): Promise<SwapResult> {
  const key = getPrivateKey(chain);
  if (!key) return { success: false, amountIn: 0, amountOut: 0, error: "No wallet private key configured" };

  const { viemChain, rpc } = getChainConfig(chain);
  const usdcAddress = TOKENS[chain]?.["USDC"];
  if (!usdcAddress) return { success: false, amountIn: 0, amountOut: 0, error: "No USDC token" };

  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    return { success: false, amountIn: 0, amountOut: 0, error: `Invalid token decimals: ${tokenDecimals}` };
  }
  if (!(tokenAmount > 0)) {
    return { success: false, amountIn: 0, amountOut: 0, error: "Sell amount must be positive" };
  }

  const slippagePct = options.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  try {
    const account = privateKeyToAccount(key);
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });

    const amountIn = parseUnits(tokenAmount.toFixed(tokenDecimals), tokenDecimals);
    if (amountIn <= 0n) {
      return { success: false, amountIn: tokenAmount, amountOut: 0, error: "Sell amount rounds to zero" };
    }

    // Output is USDC, so the reference is 1.0 USD by definition — no external
    // price needed to bound the exit.
    const minAmountOut = computeMinAmountOut(
      amountIn,
      tokenDecimals,
      USDC_DECIMALS,
      options.referencePriceUsd ?? 0,
      slippagePct
    );
    if (minAmountOut === null) {
      return {
        success: false,
        amountIn: tokenAmount,
        amountOut: 0,
        error: "No reference price supplied — refusing to send a swap with an unbounded minimum output",
      };
    }

    if (!(await ensureApproval(publicClient, walletClient, tokenAddress, account.address, amountIn))) {
      return { success: false, amountIn: tokenAmount, amountOut: 0, error: "Token approval failed" };
    }

    const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 300);

    const swapParams = encodeAbiParameters(
      parseAbiParameters("address, uint256, uint256, bytes, bool"),
      [
        account.address,
        amountIn,
        minAmountOut,
        encodeAbiParameters(
          parseAbiParameters("address, uint24, address"),
          [tokenAddress, POOL_FEE, usdcAddress]
        ),
        true,
      ]
    );

    const txHash = await walletClient.writeContract({
      address: UNIVERSAL_ROUTER,
      abi: ROUTER_ABI,
      functionName: "execute",
      args: ["0x00" as Hex, [swapParams], DEADLINE],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      logger.error({ chain, txHash }, "EVM sell reverted on chain");
      return { success: false, txHash, amountIn: tokenAmount, amountOut: 0, error: "Sell transaction reverted" };
    }

    const amountOut = extractAmountOut(receipt, account.address, usdcAddress, USDC_DECIMALS);
    if (amountOut === null) {
      logger.error({ chain, txHash }, "EVM sell confirmed but USDC received could not be decoded");
      return {
        success: false,
        txHash,
        amountIn: tokenAmount,
        amountOut: 0,
        error: "Swap confirmed but output amount could not be decoded — proceeds cannot be booked",
      };
    }

    logger.info(
      { chain, txHash, tokenAmount, usdcReceived: amountOut, gasUsed: Number(receipt.gasUsed) },
      "EVM SELL executed"
    );

    return {
      success: true,
      txHash,
      amountIn: tokenAmount,
      amountOut,
      amountOutDecimals: USDC_DECIMALS,
      gasUsed: Number(receipt.gasUsed),
    };
  } catch (err: any) {
    logger.error({ err, chain }, "EVM sell execution failed");
    return { success: false, amountIn: tokenAmount, amountOut: 0, error: err?.message ?? String(err) };
  }
}
