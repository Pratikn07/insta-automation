import { Navigate, Route, Routes } from "react-router-dom";
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
        <Route path="sequences" element={<Sequences />} />
        <Route path="sequences/:id" element={<SequenceEditor />} />
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
