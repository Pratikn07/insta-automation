import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Login } from "@/pages/Login";
import { AppRoutes } from "@/AppRoutes";

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
        <AppRoutes />
      ) : (
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
