import { useRoute, useLocation } from "wouter";
import { useGetCandles, getGetCandlesQueryKey, useListPairs, getListPairsQueryKey, useRemovePair } from "@workspace/api-client-react";
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area } from "recharts";
import { format } from "date-fns";
import { ArrowLeft, Trash2, Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export default function PairDetail() {
  const [, params] = useRoute("/pair/:id");
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const pairAddress = params?.id;
  const searchParams = new URLSearchParams(window.location.search);
  const chain = searchParams.get("chain") || "ethereum";
  
  const [timeframe, setTimeframe] = useState<"1m"|"5m"|"15m"|"1h"|"4h"|"1d">("15m");

  const { data: pairs = [] } = useListPairs({ query: { queryKey: getListPairsQueryKey() } });
  const pair = pairs.find(p => p.pairAddress === pairAddress && p.chain === chain);

  const { data: candles = [], isLoading } = useGetCandles(
    { pairAddress: pairAddress!, chain: chain as any, timeframe },
    { query: { enabled: !!pairAddress, queryKey: getGetCandlesQueryKey({ pairAddress: pairAddress!, chain: chain as any, timeframe }) } }
  );

  const removePair = useRemovePair();

  const handleRemove = () => {
    if (pair?.id) {
      removePair.mutate({ id: pair.id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPairsQueryKey() });
          setLocation("/");
        }
      });
    }
  };

  if (!pairAddress) return null;

  // Transform candles for chart
  const chartData = candles.map(c => ({
    ...c,
    timeLabel: format(new Date(c.time * 1000), timeframe === "1d" ? "MMM dd" : "HH:mm"),
    price: c.close, // Used for Area chart line
    isUp: c.close >= c.open,
    // Bar data for volume
    vol: c.volume
  }));

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex-none p-4 md:p-6 border-b border-border bg-card flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <button onClick={() => setLocation("/")} className="text-muted-foreground hover:text-foreground">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold font-mono text-foreground tracking-tight flex items-center gap-2">
              {pair?.symbol || "UNKNOWN_PAIR"}
              <span className="text-xs px-2 py-0.5 border border-border text-muted-foreground bg-background">
                {chain.toUpperCase()}
              </span>
            </h1>
            <p className="text-xs font-mono text-muted-foreground mt-1 truncate max-w-md">
              {pairAddress}
            </p>
          </div>
        </div>

        {pair && (
          <div className="flex items-center gap-4">
            <div className="flex flex-col text-right font-mono">
              <span className="text-lg text-foreground font-bold">${pair.currentPrice.toFixed(4)}</span>
              <span className={`text-xs ${pair.priceChange24h >= 0 ? "text-green-500" : "text-red-500"}`}>
                {pair.priceChange24h > 0 ? "+" : ""}{pair.priceChange24h.toFixed(2)}%
              </span>
            </div>
            <button 
              onClick={handleRemove}
              disabled={removePair.isPending}
              className="p-2 border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
              title="REMOVE_FROM_WATCHLIST"
            >
              <Trash2 size={18} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 p-4 md:p-6 flex flex-col gap-6">
        {/* Microstructure State */}
        {pair && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border border-border bg-card p-4 flex flex-col gap-2">
              <span className="font-mono text-xs text-muted-foreground">CURRENT_STATE</span>
              <div className="font-mono text-sm font-bold text-primary flex items-center gap-2">
                <Activity size={16} />
                {pair.state}
              </div>
            </div>
            <div className="border border-border bg-card p-4 flex flex-col gap-2">
              <span className="font-mono text-xs text-muted-foreground">HTF_LOGIC</span>
              <div className="font-mono text-sm text-foreground">
                {pair.htfMessage || "NO_DATA"}
              </div>
            </div>
            <div className="border border-border bg-card p-4 flex flex-col gap-2">
              <span className="font-mono text-xs text-muted-foreground">LTF_FRACTAL</span>
              <div className="font-mono text-sm text-foreground">
                {pair.ltfMessage || "NO_DATA"}
              </div>
            </div>
          </div>
        )}

        {/* Chart Area */}
        <div className="flex-1 border border-border bg-card flex flex-col min-h-[400px]">
          <div className="flex p-2 border-b border-border bg-secondary/50 gap-1 overflow-x-auto">
            {(["1m", "5m", "15m", "1h", "4h", "1d"] as const).map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-3 py-1 font-mono text-xs font-bold transition-colors ${timeframe === tf ? "bg-accent text-primary border border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="flex-1 p-4">
            {isLoading ? (
              <div className="h-full w-full flex items-center justify-center font-mono text-muted-foreground animate-pulse">
                INITIALIZING_CHART_DATA...
              </div>
            ) : chartData.length === 0 ? (
              <div className="h-full w-full flex items-center justify-center font-mono text-muted-foreground">
                NO_CANDLE_DATA_AVAILABLE.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="timeLabel" 
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontFamily: 'monospace' }} 
                    stroke="hsl(var(--border))"
                    minTickGap={30}
                  />
                  <YAxis 
                    domain={['auto', 'auto']} 
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontFamily: 'monospace' }} 
                    stroke="hsl(var(--border))"
                    orientation="right"
                    tickFormatter={(val) => val.toFixed(4)}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontFamily: 'monospace', fontSize: 12 }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                    labelStyle={{ color: 'hsl(var(--primary))', marginBottom: 4 }}
                  />
                  
                  {/* Price Line/Area */}
                  <Area 
                    type="monotone" 
                    dataKey="price" 
                    stroke="hsl(var(--primary))" 
                    fill="hsl(var(--primary) / 0.1)" 
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  
                  {/* Volume Bars */}
                  <Bar 
                    dataKey="vol" 
                    fill="hsl(var(--muted-foreground) / 0.2)" 
                    yAxisId={0} 
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
