import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The house index.
 *
 * Typographic, not iconographic: Maison has no icon system, and a lucide glyph
 * beside each label would be the dashboard tell the whole world is refusing.
 * The active route is set in Bodoni italic rather than given a filled pill —
 * the type carries state, so the column needs no background at all.
 *
 * Grouped rather than merged. The four headings are the agreed information
 * architecture (Measure / Publish / Audience / System) and they land now because
 * grouping is reversible and costs nothing. The merges behind them — Keywords
 * into Content, Users into People, Insights and Funnels into Analysis — are page
 * work, and Keywords in particular is opened daily; it stays reachable until the
 * page that absorbs it exists.
 */
const groups: { heading: string; items: { to: string; label: string }[] }[] = [
  {
    heading: "Measure",
    items: [
      { to: "/", label: "Home" },
      { to: "/insights", label: "Insights" },
      { to: "/funnels", label: "Funnels" },
    ],
  },
  {
    heading: "Publish",
    items: [
      { to: "/content", label: "Content" },
      { to: "/keywords", label: "Keywords" },
      { to: "/sequences", label: "Sequences" },
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
    <aside className="flex h-full w-56 shrink-0 flex-col overflow-y-auto border-r bg-background pb-8 pt-10">
      <div className="px-7">
        <div className="font-display text-2xl uppercase leading-[1.15] tracking-[0.09em]">
          Tiny
          <br />
          Soho
        </div>
        <div className="mt-3.5 h-px w-6 bg-gold" />
      </div>

      <nav className="mt-7">
        {groups.map(({ heading, items }) => (
          <div key={heading} className="mb-1.5">
            <div className="label-caps px-7 pb-2 pt-5">{heading}</div>
            {items.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex items-center py-1.5 pl-7 pr-5 text-[13.5px] tracking-[0.06em] transition-[padding,color,opacity] duration-300 ease-out",
                    // 44px minimum on touch only. The editorial rhythm of the
                    // index depends on tight leading, so a coarse pointer gets
                    // the target and a mouse keeps the density.
                    "[@media(pointer:coarse)]:min-h-11",
                    // Press feedback on pointer-down. Hover does not exist on a
                    // phone, and this is the one place she taps daily.
                    "active:opacity-60",
                    isActive
                      ? "font-display text-[15px] italic tracking-normal text-gold-text"
                      : "text-foreground hover:pl-9 hover:text-gold-text",
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
