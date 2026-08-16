import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The rail.
 *
 * Light and integrated rather than a dark chrome panel: the sidebar is where a
 * console most reliably announces itself as generic, and a filled dark rectangle
 * beside a light page is the single strongest tell. Here it is the same paper as
 * the page, separated by one rule, and the active route is marked by a moss edge
 * rather than a filled pill.
 *
 * Typographic, no icons. An icon beside every label adds a column of noise to a
 * list a daily user learned by position within a week.
 *
 * Grouped, not merged. The four headings are the agreed information architecture
 * and they cost nothing because grouping is reversible. The merges behind them —
 * Keywords into Content, Users into Conversations, Insights and Funnels into one
 * Analysis view — are page work, and Keywords is opened daily; nothing leaves the
 * rail before the page that absorbs it exists.
 */
const groups: { heading: string; items: { to: string; label: string }[] }[] = [
  {
    heading: "Daily",
    items: [
      { to: "/", label: "Home" },
      { to: "/content", label: "Content" },
      { to: "/keywords", label: "Keywords" },
      { to: "/sequences", label: "Sequences" },
    ],
  },
  {
    heading: "Review",
    items: [
      { to: "/insights", label: "Insights" },
      { to: "/funnels", label: "Funnels" },
    ],
  },
  {
    heading: "Audience",
    items: [
      { to: "/conversations", label: "Conversations" },
      { to: "/users", label: "Users" },
      { to: "/historical-recovery", label: "Recovery" },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/activity", label: "Activity" },
      { to: "/assistant", label: "Assistant" },
    ],
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <aside className="flex h-full w-52 shrink-0 flex-col overflow-y-auto border-r bg-background py-5">
      <div className="flex items-center gap-2 px-5 pb-5">
        <span className="size-3 shrink-0 rounded-[2px] bg-signal" />
        <span className="text-sm font-medium tracking-tight">tinysoho</span>
      </div>

      <nav>
        {groups.map(({ heading, items }) => (
          <div key={heading}>
            <div className="label-caps px-5 pb-1.5 pt-4">{heading}</div>
            {items.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-8 items-center border-l-2 px-5 py-1.5 text-[13px] transition-colors",
                    // 44px on touch only: the rail's rhythm depends on tight
                    // leading, so a mouse keeps the density and a thumb gets the
                    // target.
                    "[@media(pointer:coarse)]:min-h-11",
                    "active:opacity-60",
                    isActive
                      ? "border-l-signal font-medium text-foreground"
                      : "border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
