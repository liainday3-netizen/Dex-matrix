import { useListSignals, getListSignalsQueryKey, Signal } from "@workspace/api-client-react";
import { ArrowUpRight, ArrowDownRight, Clock, Target } from "lucide-react";
import { format } from "date-fns";

export default function Signals() {
  const { data: signals = [], isLoading } = useListSignals(
    { limit: 100 },
    { query: { refetchInterval: 10000, queryKey: getListSignalsQueryKey({ limit: 100 }) } }
  );

  if (isLoading && signals.length === 0) {
    return <div className="p-6 text-muted-foreground font-mono animate-pulse">LOADING_SIGNAL_HISTORY...</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6 border-b border-border pb-4">
        <h1 className="text-2xl font-bold font-mono text-foreground tracking-tight flex items-center gap-2">
          <Target className="text-primary" />
          EXECUTION_LOG
        </h1>
        <p className="text-sm font-mono text-muted-foreground mt-2">
          HISTORICAL_LOG_OF_ALL_CONFIRMED_MICROSTRUCTURE_SIGNALS.
        </p>
      </div>

      <div className="border border-border bg-card flex flex-col">
        <div className="grid grid-cols-[1fr_1fr_1fr_2fr_1fr] gap-4 p-4 border-b border-border bg-secondary text-xs font-mono text-muted-foreground font-semibold">
          <div>TIMESTAMP</div>
          <div>ASSET</div>
          <div className="text-right">PRICE</div>
          <div>LOGIC TRIGGER</div>
          <div className="text-right">DIRECTION</div>
        </div>

        <div className="flex flex-col divide-y divide-border">
          {signals.map((sig) => (
            <div key={sig.id} className="grid grid-cols-[1fr_1fr_1fr_2fr_1fr] gap-4 p-4 items-center hover:bg-secondary/50 transition-colors">
              <div className="font-mono text-xs text-muted-foreground flex items-center gap-2">
                <Clock size={12} />
                {format(new Date(sig.triggeredAt), "HH:mm:ss.SSS")}
                <span className="text-[10px] opacity-50">{format(new Date(sig.triggeredAt), "MMM dd")}</span>
              </div>

              <div className="flex items-center gap-2 font-mono font-bold text-sm text-foreground">
                {sig.symbol}
              </div>

              <div className="font-mono text-sm text-foreground text-right">
                ${sig.price.toFixed(4)}
              </div>

              <div className="font-mono text-xs text-muted-foreground truncate" title={sig.ltfMessage}>
                {sig.ltfMessage}
              </div>

              <div className="flex justify-end">
                {sig.direction === "BUY" ? (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 border border-green-500/20 text-green-500 font-mono text-xs font-bold">
                    <ArrowUpRight size={14} />
                    LONG
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-red-500/10 border border-red-500/20 text-red-500 font-mono text-xs font-bold">
                    <ArrowDownRight size={14} />
                    SHORT
                  </div>
                )}
              </div>
            </div>
          ))}

          {signals.length === 0 && (
            <div className="p-8 text-center text-muted-foreground font-mono">
              NO_SIGNALS_RECORDED.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
