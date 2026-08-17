import { useState } from "react";
import { DmRecoveryList } from "@/components/conversations/DmRecoveryList";
import { DmRecoveryDrawer } from "@/components/conversations/DmRecoveryDrawer";
import { UserLineage } from "@/components/UserLineage";
import { Drawer } from "@/components/ui/drawer";

/**
 * DM recovery: its own destination, not a lens.
 *
 * It used to be a pill in the Conversations filter row, sitting between "DMs"
 * and the automation-journey filters. Everything either side of it is a way of
 * looking at what already happened. This one monitors eligibility for an
 * automatic public reminder on the original Instagram comment — the only
 * control in that row that can publish anything.
 *
 * Peer tabs are the specific surface on which that goes wrong: the row is
 * learned by position within a week, and by the second week the click is
 * habitual and the label is no longer read. A destination cannot be reached by
 * a habit formed on a neighbouring view.
 *
 * Grouped beside Historical recovery in the rail rather than tabbed with it,
 * for the same reason and at higher stakes — see Sidebar.tsx.
 */
export function DmRecovery() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Carried over with the list rather than dropped: onOpenUser is optional on the
  // drawer, so omitting it here would have silently removed the route from a
  // reminder to that person's history — the one check worth making before a
  // reminder goes out.
  const [lineageUser, setLineageUser] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">DM recovery</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          If no read or engagement is confirmed after the waiting period, Tiny Soho may
          automatically post one public reminder on the original Instagram comment. You can
          cancel before the worker claims it.
        </p>
      </div>

      <DmRecoveryList onSelect={setSelectedId} />

      <Drawer
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title="DM recovery reminder"
      >
        {selectedId && (
          <DmRecoveryDrawer
            id={selectedId}
            onClose={() => setSelectedId(null)}
            onOpenUser={(id) => setLineageUser(id)}
          />
        )}
      </Drawer>

      <Drawer
        open={lineageUser !== null}
        onClose={() => setLineageUser(null)}
        title="User journey"
      >
        {lineageUser && <UserLineage igUserId={lineageUser} />}
      </Drawer>
    </div>
  );
}
