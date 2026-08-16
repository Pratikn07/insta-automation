import { LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut, useAuth } from "@/hooks/useAuth";

/**
 * A running head, not a toolbar.
 *
 * On desktop the page title lives in the page itself (the folio rule), so this
 * bar carries only identity and the way out, and it disappears entirely below
 * the fold of attention. On mobile it regains the title, because there the
 * sidebar is closed and nothing else names where you are.
 */
export function TopBar({
  title,
  onMenuClick,
}: {
  title: string;
  onMenuClick?: () => void;
}) {
  const { session } = useAuth();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-5 sm:px-8">
      <div className="flex min-w-0 items-center gap-2">
        {onMenuClick && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onMenuClick}
            className="-ml-2 md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-4" />
          </Button>
        )}
        <h1 className="font-display truncate text-lg tracking-tight md:hidden">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="label-caps hidden normal-case tracking-[0.14em] sm:inline">
          {session?.user.email}
        </span>
        <Button size="icon" variant="ghost" onClick={signOut} title="Sign out">
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
