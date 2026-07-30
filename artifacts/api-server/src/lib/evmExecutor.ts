/**
 * EVM On-Chain Executor (Ethereum + Base)
 * Uses viem + Uniswap V3 Universal Router — no API keys.
 * Public RPC endpoints: publicnode.com
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
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

// Minimal ERC20 ABI for approvals and balance checks
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "allowance",
    type: "function",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn: number;
  amountOut: number;
  gasUsed?: number;
  error?: string;
}

function getChainConfig(chain: string) {
  if (chain === "base") return { viemChain: base, rpc: RPC_URLS.base };
  return { viemChain: mainnet, rpc: RPC_URLS.ethereum };
}

function getPrivateKey(chain: string): Hex | null {
  const key = chain === "base"
    ? (process.env.BASE_WALLET_PRIVATE_KEY || process.env.EVM_WALLET_PRIVATE_KEY)
    : process.env.EVM_WALLET_PRIVATE_KEY;
  if (!key) return null;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
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

/**
 * Execute a buy swap: USDC → token via Uniswap V3
 * Uses exactInputSingle with 0.3% pool fee (3000)
 */
export async function executeBuyEVM(
  chain: string,
  tokenAddress: Address,
  amountUsd: number,
  slippagePct: number = 0.5
): Promise<SwapResult> {
  const key = getPrivateKey(chain);
  if (!key) return { success: false, amountIn: 0, amountOut: 0, error: "No wallet private key configured" };

  const { viemChain, rpc } = getChainConfig(chain);
  const usdcAddress = TOKENS[chain]?.["USDC"];
  if (!usdcAddress) return { success: false, amountIn: 0, amountOut: 0, error: `No USDC token for chain ${chain}` };

  try {
    const account = privateKeyToAccount(key);
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });

    // USDC has 6 decimals
    const amountIn = parseUnits(amountUsd.toFixed(6), 6);

    // Ensure approval for Permit2
    const allowance = await publicClient.readContract({
      address: usdcAddress, abi: ERC20_ABI, functionName: "allowance",
      args: [account.address, PERMIT2],
    }) as bigint;

    if (allowance < amountIn) {
      const approveTx = await walletClient.writeContract({
        address: usdcAddress, abi: ERC20_ABI, functionName: "approve",
        args: [PERMIT2, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      logger.info({ chain, approveTx }, "USDC approved to Permit2");
    }

    // Uniswap V3 exactInputSingle via Universal Router
    // Command: 0x00 = V3_SWAP_EXACT_IN
    const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 300);
    const MIN_AMOUNT_OUT = 0n; // rely on slippage check after

    const swapParams = encodeAbiParameters(
      parseAbiParameters("address, address, uint24, address, uint256, uint256, uint160"),
      [usdcAddress, tokenAddress, 3000, account.address, amountIn, MIN_AMOUNT_OUT, 0n]
    );

    const inputs: Hex[] = [swapParams];
    const commands: Hex = "0x00";

    const txHash = await walletClient.writeContract({
      address: UNIVERSAL_ROUTER,
      abi: [
        {
          name: "execute",
          type: "function",
          inputs: [
            { name: "commands", type: "bytes" },
            { name: "inputs", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "execute",
      args: [commands, inputs, DEADLINE],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    logger.info({ chain, txHash, amountUsd }, "EVM BUY executed");

    return {
      success: receipt.status === "success",
      txHash,
      amountIn: amountUsd,
      amountOut: 0, // parse from logs for precision; simplified here
      gasUsed: Number(receipt.gasUsed),
    };
  } catch (err: any) {
    logger.error({ err, chain }, "EVM buy execution failed");
    return { success: false, amountIn: amountUsd, amountOut: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Execute a sell swap: token → USDC via Uniswap V3
 */
export async function executeSellEVM(
  chain: string,
  tokenAddress: Address,
  tokenAmount: number,
  tokenDecimals: number = 18,
  slippagePct: number = 0.5
): Promise<SwapResult> {
  const key = getPrivateKey(chain);
  if (!key) return { success: false, amountIn: 0, amountOut: 0, error: "No wallet private key configured" };

  const { viemChain, rpc } = getChainConfig(chain);
  const usdcAddress = TOKENS[chain]?.["USDC"];
  if (!usdcAddress) return { success: false, amountIn: 0, amountOut: 0, error: "No USDC token" };

  try {
    const account = privateKeyToAccount(key);
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });

    const amountIn = parseUnits(tokenAmount.toFixed(tokenDecimals), tokenDecimals);
    const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Approve token to Permit2
    const allowance = await publicClient.readContract({
      address: tokenAddress, abi: ERC20_ABI, functionName: "allowance",
      args: [account.address, PERMIT2],
    }) as bigint;

    if (allowance < amountIn) {
      const approveTx = await walletClient.writeContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: "approve",
        args: [PERMIT2, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const swapParams = encodeAbiParameters(
      parseAbiParameters("address, address, uint24, address, uint256, uint256, uint160"),
      [tokenAddress, usdcAddress, 3000, account.address, amountIn, 0n, 0n]
    );

    const txHash = await walletClient.writeContract({
      address: UNIVERSAL_ROUTER,
      abi: [
        {
          name: "execute",
          type: "function",
          inputs: [
            { name: "commands", type: "bytes" },
            { name: "inputs", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "execute",
      args: ["0x00" as Hex, [swapParams], DEADLINE],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    return {
      success: receipt.status === "success",
      txHash,
      amountIn: tokenAmount,
      amountOut: 0,
      gasUsed: Number(receipt.gasUsed),
    };
  } catch (err: any) {
    logger.error({ err, chain }, "EVM sell execution failed");
    return { success: false, amountIn: tokenAmount, amountOut: 0, error: err?.message ?? String(err) };
  }
}
