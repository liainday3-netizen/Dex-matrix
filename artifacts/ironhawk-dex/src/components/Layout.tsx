import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useGetScannerStats, getGetScannerStatsQueryKey } from "@workspace/api-client-react";
import { Activity, LayoutDashboard, History, Telescope, TerminalSquare } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: stats } = useGetScannerStats({
    query: { refetchInterval: 10000, queryKey: getGetScannerStatsQueryKey() }
  });

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      {/* Top Stats Bar */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-4 py-2 text-xs font-mono border-b border-border bg-background">
          <div className="flex items-center gap-2 text-primary font-bold tracking-wider">
            <TerminalSquare size={14} />
            <span>IRONHAWK_DEX_SCANNER // TERMINAL</span>
          </div>
          <div className="flex items-center gap-4 text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              <span>SYS_ONLINE</span>
            </div>
            <span>{new Date().toISOString().split('T')[1].slice(0, -1)}Z</span>
          </div>
        </div>
        
        <div className="flex items-center px-4 h-12 gap-8 font-mono text-sm overflow-x-auto whitespace-nowrap">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">WATCHED_PAIRS:</span>
            <span className="font-bold text-foreground">{stats?.totalPairs ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">BULL_EXEC:</span>
            <span className="font-bold text-green-500">{stats?.activeBull ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">BEAR_EXEC:</span>
            <span className="font-bold text-red-500">{stats?.activeBear ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">IN_POI:</span>
            <span className="font-bold text-primary">{stats?.inPoi ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">SIGNALS_TODAY:</span>
            <span className="font-bold text-foreground">{stats?.signalsToday ?? 0}</span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-16 lg:w-48 border-r border-border bg-card flex flex-col py-4">
          <nav className="flex flex-col gap-2 px-2">
            <NavItem href="/" icon={<LayoutDashboard size={18} />} label="MATRIX" active={location === "/"} />
            <NavItem href="/signals" icon={<History size={18} />} label="SIGNALS" active={location === "/signals"} />
            <NavItem href="/market" icon={<Telescope size={18} />} label="MARKET" active={location === "/market"} />
          </nav>
        </aside>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavItem({ href, icon, label, active }: { href: string; icon: ReactNode; label: string; active: boolean }) {
  return (
    <Link href={href} className={`flex items-center gap-3 px-3 py-3 font-mono text-sm transition-colors border ${active ? "bg-accent text-primary border-primary" : "text-muted-foreground border-transparent hover:border-border hover:bg-secondary hover:text-foreground"}`}>
      {icon}
      <span className="hidden lg:block">{label}</span>
    </Link>
  );
}
