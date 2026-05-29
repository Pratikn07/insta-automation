import { LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut, useAuth } from "@/hooks/useAuth";

export function TopBar({
  title,
  onMenuClick,
}: {
  title: string;
  onMenuClick?: () => void;
}) {
  const { session } = useAuth();
  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {onMenuClick && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onMenuClick}
            className="md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-4" />
          </Button>
        )}
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm sm:gap-3">
        <span className="hidden text-muted-foreground sm:inline">
          {session?.user.email}
        </span>
        <Button size="icon" variant="ghost" onClick={signOut} title="Sign out">
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
