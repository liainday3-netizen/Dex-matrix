import { useListPairs, getListPairsQueryKey, WatchedPair } from "@workspace/api-client-react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, ArrowUpRight, ArrowDownRight, Clock, AlertTriangle } from "lucide-react";

const CHAIN_COLORS: Record<string, string> = {
  ethereum: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  base: "bg-indigo-500/10 text-indigo-500 border-indigo-500/20",
  solana: "bg-purple-500/10 text-purple-500 border-purple-500/20"
};

const STATE_CONFIG: Record<string, { color: string, label: string, icon: any }> = {
  BULL_EXEC: { color: "text-green-500 bg-green-500/10 border-green-500/20", label: "EXECUTE BUY", icon: ArrowUpRight },
  BEAR_EXEC: { color: "text-red-500 bg-red-500/10 border-red-500/20", label: "EXECUTE SELL", icon: ArrowDownRight },
  IN_HTF_POI: { color: "text-primary bg-primary/10 border-primary/20", label: "MONITOR LTF", icon: Activity },
  OUT_OF_SESSION: { color: "text-slate-500 bg-slate-500/10 border-slate-500/20", label: "OUT OF SESSION", icon: Clock },
  FILTERED_BIAS: { color: "text-gray-400 bg-gray-400/10 border-gray-400/20", label: "D1 FILTERED", icon: AlertTriangle },
  WAITING: { color: "text-slate-400 bg-slate-400/10 border-slate-400/20", label: "WAITING", icon: Clock },
  SYNC_ERROR: { color: "text-dim-gray bg-gray-800 border-gray-700", label: "SYNC ERROR", icon: AlertTriangle }
};

export default function Home() {
  const { data: pairs = [], isLoading } = useListPairs({
    query: { refetchInterval: 10000, queryKey: getListPairsQueryKey() }
  });

  if (isLoading && pairs.length === 0) {
    return <div className="p-6 text-muted-foreground font-mono animate-pulse">LOADING_MATRIX_DATA...</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold font-mono text-foreground tracking-tight">SCANNER_MATRIX</h1>
        <div className="text-xs font-mono text-muted-foreground flex gap-4">
          <span className="flex items-center gap-1"><div className="w-2 h-2 bg-green-500"></div> BULL</span>
          <span className="flex items-center gap-1"><div className="w-2 h-2 bg-red-500"></div> BEAR</span>
          <span className="flex items-center gap-1"><div className="w-2 h-2 bg-primary"></div> POI</span>
        </div>
      </div>

      <div className="border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-[1.5fr_1fr_1.5fr_2fr_1.5fr] gap-4 p-4 border-b border-border bg-secondary text-xs font-mono text-muted-foreground font-semibold">
          <div>ASSET</div>
          <div className="text-right">PRICE / 24H</div>
          <div>HTF LOGIC</div>
          <div>LTF FRACTAL LOGIC</div>
          <div className="text-right">ACTION</div>
        </div>

        <div className="flex flex-col">
          <AnimatePresence>
            {pairs.map((pair) => (
              <PairRow key={pair.id} pair={pair} />
            ))}
          </AnimatePresence>
          {pairs.length === 0 && (
            <div className="p-8 text-center text-muted-foreground font-mono">
              NO_ASSETS_WATCHED. GOTO /MARKET TO ADD.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PairRow({ pair }: { pair: WatchedPair }) {
  const stateCfg = STATE_CONFIG[pair.state] || STATE_CONFIG.WAITING;
  const Icon = stateCfg.icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`grid grid-cols-[1.5fr_1fr_1.5fr_2fr_1.5fr] gap-4 p-4 border-b border-border items-center hover:bg-secondary/50 transition-colors group group-hover:cursor-pointer`}
    >
      <Link href={`/pair/${pair.pairAddress}?chain=${pair.chain}`} className="contents">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 font-mono font-bold text-sm">
            <span className="text-foreground">{pair.symbol}</span>
            <span className={`text-[10px] px-1.5 py-0.5 border ${CHAIN_COLORS[pair.chain] || "border-border text-muted-foreground"}`}>
              {pair.chain.toUpperCase()}
            </span>
          </div>
          <span className="text-xs font-mono text-muted-foreground">{pair.dex.toUpperCase()}</span>
        </div>

        <div className="flex flex-col gap-1 text-right">
          <span className="font-mono text-sm text-foreground">${pair.currentPrice.toFixed(4)}</span>
          <span className={`font-mono text-xs ${pair.priceChange24h >= 0 ? "text-green-500" : "text-red-500"}`}>
            {pair.priceChange24h > 0 ? "+" : ""}{pair.priceChange24h.toFixed(2)}%
          </span>
        </div>

        <div className="font-mono text-xs text-muted-foreground truncate" title={pair.htfMessage}>
          {pair.htfMessage || "SYNCING..."}
        </div>

        <div className="font-mono text-xs text-muted-foreground truncate" title={pair.ltfMessage}>
          {pair.ltfMessage || "-"}
        </div>

        <div className="flex justify-end">
          <div className={`flex items-center gap-1.5 px-2.5 py-1.5 border text-xs font-bold font-mono ${stateCfg.color}`}>
            <Icon size={12} strokeWidth={3} />
            {stateCfg.label}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
