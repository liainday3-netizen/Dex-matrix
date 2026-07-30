import { useState } from "react";
import { useSearchPairs, getSearchPairsQueryKey, useGetTrendingPairs, getGetTrendingPairsQueryKey, useAddPair, getListPairsQueryKey, useListPairs, MarketPair } from "@workspace/api-client-react";
import { Search, Telescope, Plus, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Market() {
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<"ethereum" | "base" | "solana">("ethereum");
  const queryClient = useQueryClient();

  const { data: watchedPairs = [] } = useListPairs({
    query: { queryKey: getListPairsQueryKey() }
  });

  const { data: searchResults = [], isLoading: isSearchLoading } = useSearchPairs(
    { q: query, chain },
    { query: { enabled: query.length >= 2, queryKey: getSearchPairsQueryKey({ q: query, chain }) } }
  );

  const { data: trendingPairs = [], isLoading: isTrendingLoading } = useGetTrendingPairs(
    { chain },
    { query: { enabled: query.length < 2, queryKey: getGetTrendingPairsQueryKey({ chain }) } }
  );

  const addPair = useAddPair();

  const handleAdd = (pair: MarketPair) => {
    addPair.mutate(
      { data: { pairAddress: pair.pairAddress, chain: pair.chain as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPairsQueryKey() });
        }
      }
    );
  };

  const displayPairs = query.length >= 2 ? searchResults : trendingPairs;
  const isLoading = query.length >= 2 ? isSearchLoading : isTrendingLoading;
  const isSearchActive = query.length >= 2;

  const watchedSet = new Set(watchedPairs.map((p) => `${p.chain}-${p.pairAddress}`));

  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col gap-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono text-foreground tracking-tight flex items-center gap-2">
            <Telescope className="text-primary" />
            MARKET_DISCOVERY
          </h1>
          <p className="text-sm font-mono text-muted-foreground mt-2">
            SCAN_DEX_LIQUIDITY_POOLS_FOR_NEW_TARGETS.
          </p>
        </div>

        <div className="flex bg-card border border-border p-1">
          {(["ethereum", "base", "solana"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className={`px-4 py-1.5 font-mono text-xs font-bold uppercase transition-colors ${chain === c ? "bg-accent text-primary border border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <div className="absolute inset-y-0 left-0 flex items-center pl-4 text-muted-foreground">
          <Search size={18} />
        </div>
        <input
          type="text"
          placeholder="SEARCH_BY_SYMBOL_OR_CONTRACT..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-card border border-border py-4 pl-12 pr-4 font-mono text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-mono text-xs font-bold text-muted-foreground uppercase">
          {isSearchActive ? "SEARCH_RESULTS" : "TRENDING_POOLS_24H"}
        </h2>

        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground font-mono animate-pulse">SCANNING_NETWORK...</div>
        ) : displayPairs.length === 0 ? (
          <div className="p-8 text-center border border-border bg-card text-muted-foreground font-mono">
            NO_RESULTS_FOUND.
          </div>
        ) : (
          <div className="border border-border bg-card flex flex-col divide-y divide-border">
            {displayPairs.map((pair) => {
              const isWatched = watchedSet.has(`${pair.chain}-${pair.pairAddress}`);
              return (
                <div key={pair.pairAddress} className="flex flex-col md:flex-row md:items-center justify-between p-4 hover:bg-secondary/50 transition-colors gap-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 font-mono font-bold">
                      <span className="text-foreground">{pair.symbol}</span>
                      <span className="text-xs text-muted-foreground">{pair.dex.toUpperCase()}</span>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground truncate">
                      {pair.pairAddress}
                    </div>
                  </div>

                  <div className="flex items-center gap-8 justify-between md:justify-end">
                    <div className="flex flex-col text-right">
                      <span className="font-mono text-sm text-foreground">${pair.price.toFixed(6)}</span>
                      <span className={`font-mono text-xs ${pair.priceChange24h >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {pair.priceChange24h > 0 ? "+" : ""}{pair.priceChange24h.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex flex-col text-right hidden sm:flex">
                      <span className="font-mono text-sm text-foreground">${(pair.volume24h / 1000000).toFixed(2)}M</span>
                      <span className="font-mono text-xs text-muted-foreground">VOL 24H</span>
                    </div>
                    <button
                      onClick={() => !isWatched && handleAdd(pair)}
                      disabled={isWatched || addPair.isPending}
                      className={`flex items-center justify-center w-10 h-10 border transition-colors ${
                        isWatched 
                          ? "bg-secondary text-primary border-border cursor-not-allowed" 
                          : "bg-primary/10 text-primary border-primary/30 hover:bg-primary/20 hover:border-primary"
                      }`}
                    >
                      {isWatched ? <Check size={18} /> : <Plus size={18} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
