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
 * The groups and destination names below come from PRODUCT.md's information
 * architecture section, which is the record of what exists and what it is called.
 * This file does not hold opinions about what should merge later: the comment
 * that used to live here predicted three merges, two of which were subsequently
 * rejected, which left a component quietly asserting design authority nobody had
 * agreed to. Read the record, change the record, then change this list.
 *
 * The one rule that is a safety boundary rather than a preference: DM recovery
 * and historical recovery are grouped but never tabbed. Approving in the latter
 * posts public comments on hundreds of real posts, and peer tabs are exactly the
 * surface on which a habitual click means something different. DM recovery was a
 * pill in the Conversations filter row until it became the route below.
 */
/** Home stands above the groups: it is the surface, not a category within one. */
const HOME = { to: "/", label: "Home" };

const groups: { heading: string; items: { to: string; label: string }[] }[] = [
  {
    heading: "Measure",
    items: [
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
      // The two recovery destinations, adjacent and last. Both keep the qualifier:
      // they are different mechanisms with very different blast radius, and one
      // unqualified "Recovery" beside the other would invite the wrong click.
      // Adjacent in the rail is the grouping; neither is reachable from the other.
      { to: "/dm-recovery", label: "DM recovery" },
      { to: "/historical-recovery", label: "Historical recovery" },
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

/** One definition, so Home and the grouped items cannot drift apart. */
const railLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex min-h-8 items-center border-l-2 px-5 py-1.5 text-[13px] transition-colors",
    // 44px on touch only: the rail's rhythm depends on tight leading, so a mouse
    // keeps the density and a thumb gets the target.
    "[@media(pointer:coarse)]:min-h-11",
    "active:opacity-60",
    isActive
      ? "border-l-signal font-medium text-foreground"
      : "border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
  );

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <aside className="flex h-full w-52 shrink-0 flex-col overflow-y-auto border-r bg-background py-5">
      <div className="flex items-center gap-2 px-5 pb-5">
        <span className="size-3 shrink-0 rounded-[2px] bg-signal" />
        <span className="text-sm font-medium tracking-tight">tinysoho</span>
      </div>

      <nav>
        <NavLink to={HOME.to} end onClick={onNavigate} className={railLink}>
          {HOME.label}
        </NavLink>

        {groups.map(({ heading, items }) => (
          <div key={heading}>
            <div className="label-caps px-5 pb-1.5 pt-4">{heading}</div>
            {items.map(({ to, label }) => (
              <NavLink key={to} to={to} onClick={onNavigate} className={railLink}>
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
