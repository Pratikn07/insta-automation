import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { Home } from "@/pages/Home";
import { Content } from "@/pages/Content";
import { Keywords } from "@/pages/Keywords";
import { Sequences } from "@/pages/Sequences";
import { SequenceEditor } from "@/pages/SequenceEditor";
import { Conversations } from "@/pages/Conversations";
import { DmRecovery } from "@/pages/DmRecovery";
import { Assistant } from "@/pages/Assistant";
import { Activity } from "@/pages/Activity";
import { Flags } from "@/pages/Flags";
import { Insights } from "@/pages/Insights";
import { Funnels } from "@/pages/Funnels";
import { HistoricalRecovery } from "@/pages/HistoricalRecovery";

/**
 * Carries the id across the /sequences/:id → /guides/:id rename.
 *
 * A plain `<Navigate to="/guides">` would drop the id and land on the list, which
 * turns a bookmark to one guide into a bookmark to all of them.
 */
function SequenceRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/guides/${id}` : "/guides"} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="content" element={<Content />} />
        {/* /reels was this page's old home — keep the URL working for
            bookmarks rather than bouncing them to the dashboard. */}
        <Route path="reels" element={<Navigate to="/content" replace />} />
        <Route path="keywords" element={<Keywords />} />
        <Route path="guides" element={<Sequences />} />
        <Route path="guides/:id" element={<SequenceEditor />} />
        {/* Renamed from /sequences. One object was called a sequence in the nav, a
            guide in the upcoming-setup form, and a resource in the database, so
            landing on the editor from that form told you nothing connected them.
            Guide won because it is what the DM itself says. Old links redirect
            rather than 404, same as /reels and /users above. */}
        <Route path="sequences" element={<Navigate to="/guides" replace />} />
        <Route path="sequences/:id" element={<SequenceRedirect />} />
        <Route path="conversations" element={<Conversations />} />
        {/* Deliberately "dm-recovery", not "recovery": historical recovery is a
            separate mechanism with far larger blast radius, and a bare /recovery
            would be the wrong thing to guess at. */}
        <Route path="dm-recovery" element={<DmRecovery />} />
        <Route path="assistant" element={<Assistant />} />
        {/* /users folded into Conversations as the People lens — same dataset
            indexed by person, same lineage drawer. Preserve that intent for old
            bookmarks instead of opening the default Needs reply lens. */}
        <Route
          path="users"
          element={<Navigate to="/conversations?lens=people" replace />}
        />
        <Route path="insights" element={<Insights />} />
        <Route path="funnels" element={<Funnels />} />
        <Route path="flags" element={<Flags />} />
        <Route path="activity" element={<Activity />} />
        <Route path="historical-recovery" element={<HistoricalRecovery />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
