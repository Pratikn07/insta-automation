import {
  Navigate,
  Route,
  RouterProvider,
  Routes,
  createBrowserRouter,
} from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import { Login } from "@/pages/Login";
import { Home } from "@/pages/Home";
import { Content } from "@/pages/Content";
import { Keywords } from "@/pages/Keywords";
import { Sequences } from "@/pages/Sequences";
import { SequenceEditor } from "@/pages/SequenceEditor";
import { Conversations } from "@/pages/Conversations";
import { Assistant } from "@/pages/Assistant";
import { Activity } from "@/pages/Activity";
import { Users } from "@/pages/Users";
import { Insights } from "@/pages/Insights";
import { HistoricalRecovery } from "@/pages/HistoricalRecovery";

function FullScreenLoader() {
  return (
    <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

function AuthenticatedRoutes() {
  const { session, loading } = useAuth();

  if (loading) return <FullScreenLoader />;

  return session ? (
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
        <Route path="assistant" element={<Assistant />} />
        <Route path="users" element={<Users />} />
        <Route path="insights" element={<Insights />} />
        <Route path="activity" element={<Activity />} />
        <Route path="historical-recovery" element={<HistoricalRecovery />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  ) : (
    <Routes>
      <Route path="*" element={<Login />} />
    </Routes>
  );
}

const router = createBrowserRouter([{ path: "*", element: <AuthenticatedRoutes /> }]);

export default function App() {
  return <RouterProvider router={router} />;
}
