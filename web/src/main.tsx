import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
      // networkMode "always" instead of the default "online".
      //
      // This one line is why the console could not report a failed load. Under
      // "online", a query whose fetch fails is parked at fetchStatus "paused"
      // with status still "pending" — React Query assumes the network is down
      // and waits for it to return. `isPending` stays true forever, so every
      // page sat on its skeletons and no error branch ever ran, however long
      // you waited. The error states added across the console were unreachable
      // code until this changed.
      //
      // "always" says: run the query, and if it fails, that is an error. The
      // console reads one API on one host; when it is unreachable that IS the
      // finding, and a product whose first principle is that unknown is not
      // nothing cannot sit silently pretending to still be loading.
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {/* Light: the console is paper now. A dark toast was left over from the
          previous world and read as a foreign object dropped on the page. */}
      <Toaster theme="light" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
