import { NavLink } from "react-router-dom";
import {
  Home,
  Tag,
  Layers,
  MessageCircle,
  LayoutGrid,
  Sparkles,
  Activity,
  Users,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { to: "/", label: "Home", icon: Home },
  // "Content", not "Reels" — this page holds carousels too.
  { to: "/content", label: "Content", icon: LayoutGrid },
  { to: "/keywords", label: "Keywords", icon: Tag },
  { to: "/sequences", label: "Sequences", icon: Layers },
  { to: "/conversations", label: "Conversations", icon: MessageCircle },
  { to: "/users", label: "Users", icon: Users },
  { to: "/insights", label: "Insights", icon: BarChart3 },
  { to: "/activity", label: "Activity", icon: Activity },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card/30 px-3 py-5">
      <div className="mb-6 flex items-center gap-2 px-2">
        <div className="flex size-7 items-center justify-center rounded-md bg-brand-gradient">
          <Sparkles className="size-4 text-white" />
        </div>
        <span className="font-semibold tracking-tight">Tiny Soho</span>
      </div>
      <nav className="flex flex-col gap-1">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )
            }
          >
            <Icon className="size-4" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
