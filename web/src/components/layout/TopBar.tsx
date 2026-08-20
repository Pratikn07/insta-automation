import { LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut, useAuth } from "@/hooks/useAuth";

/**
 * The strip.
 *
 * Context, not a toolbar. On desktop the page names itself, so this carries only
 * the account and the way out. On mobile it regains the title, because with the
 * rail closed nothing else says where you are.
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
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
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
        <span className="truncate text-sm font-medium md:hidden">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="label-caps hidden normal-case tracking-[0.06em] sm:inline">
          {session?.user.email}
        </span>
        <Button size="icon" variant="ghost" onClick={signOut} title="Sign out">
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
