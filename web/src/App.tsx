import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import { Login } from "@/pages/Login";
import { Home } from "@/pages/Home";
import { Keywords } from "@/pages/Keywords";
import { Sequences } from "@/pages/Sequences";
import { SequenceEditor } from "@/pages/SequenceEditor";
import { Conversations } from "@/pages/Conversations";

function FullScreenLoader() {
  return (
    <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

export default function App() {
  const { session, loading } = useAuth();

  if (loading) return <FullScreenLoader />;

  return (
    <BrowserRouter>
      {session ? (
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Home />} />
            <Route path="keywords" element={<Keywords />} />
            <Route path="sequences" element={<Sequences />} />
            <Route path="sequences/:id" element={<SequenceEditor />} />
            <Route path="conversations" element={<Conversations />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      ) : (
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
