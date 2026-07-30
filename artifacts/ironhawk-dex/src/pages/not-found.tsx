import { AlertTriangle } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6 h-[80vh]">
      <div className="max-w-md w-full border border-destructive/30 bg-destructive/5 p-8 flex flex-col items-center text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center text-destructive mb-2">
          <AlertTriangle size={32} />
        </div>
        <h1 className="text-2xl font-bold font-mono text-destructive tracking-tight">ERR_404_NOT_FOUND</h1>
        <p className="font-mono text-sm text-muted-foreground">
          THE_REQUESTED_RESOURCE_COULD_NOT_BE_LOCATED_IN_THE_MATRIX.
          IT_MAY_HAVE_BEEN_LIQUIDATED.
        </p>
        <Link href="/" className="mt-4 px-6 py-2 border border-primary text-primary font-mono text-sm font-bold hover:bg-primary/10 transition-colors">
          RETURN_TO_BASE
        </Link>
      </div>
    </div>
  );
}
