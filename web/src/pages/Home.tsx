import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Tag, Send, Hourglass, CheckCircle2, ChevronDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Conversation, Paginated, Stats } from "@/lib/types";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

export function Home() {
  const { data, isLoading } = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
  });

  const recipientsQ = useQuery<Paginated<Conversation>>({
    queryKey: ["recent-recipients"],
    queryFn: () =>
      api<Paginated<Conversation>>("/conversations?state=completed&limit=6"),
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={<Tag className="size-4" />}
          label="Active keywords"
          value={`${data.activeKeywords}`}
          sub={`of ${data.totalKeywords} total`}
          delay={0}
        />
        <StatCard
          icon={<Send className="size-4" />}
          label="DMs sent today"
          value={`${data.dmsSentToday}`}
          sub={`${data.completedToday} sequences completed`}
          delay={0.05}
        />
        <StatCard
          icon={<Hourglass className="size-4" />}
          label="Awaiting DONE"
          value={`${data.conversationsAwaiting}`}
          sub="people who replied DONE will receive their resource"
          delay={0.1}
        />
        <StatCard
          icon={<RefreshCw className="size-4" />}
          label="Gate retries queued"
          value={`${data.gateQueuePending}`}
          sub={
            data.gateQueueExhausted > 0
              ? `${data.gateQueueExhausted} expired past the 7-day window`
              : "comment DMs waiting to retry under the rate limit"
          }
          delay={0.15}
        />
      </div>

      {data.lastError && <LastErrorRow lastError={data.lastError} />}

      <RecentRecipients
        isLoading={recipientsQ.isLoading}
        items={recipientsQ.data?.items ?? []}
      />
    </div>
  );
}

function LastErrorRow({
  lastError,
}: {
  lastError: NonNullable<Stats["lastError"]>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div {...fadeUp} transition={{ duration: 0.2, delay: 0.15 }}>
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="p-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-3 text-left text-sm"
          >
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <span className="flex-1 truncate">
              <span className="font-medium">Last error</span>
              <span className="ml-2 text-muted-foreground">
                {formatRelative(lastError.createdAt)}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
          {open && (
            <pre className="mt-3 whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {JSON.stringify(lastError.payload, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function RecentRecipients({
  isLoading,
  items,
}: {
  isLoading: boolean;
  items: Conversation[];
}) {
  return (
    <motion.div {...fadeUp} transition={{ duration: 0.2, delay: 0.2 }}>
      <Card>
        <CardContent className="p-5">
          <div className="mb-4 flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 className="size-4" />
            <CardDescription className="text-xs uppercase tracking-wide">
              Recent recipients
            </CardDescription>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody has finished a sequence yet. As people comment your keywords
              and reply DONE, they'll show up here.
            </p>
          ) : (
            <ol className="space-y-3">
              <AnimatePresence initial={false}>
                {items.map((c, i) => (
                  <motion.li
                    key={c.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(i * 0.02, 0.2) }}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                      <span className="truncate">
                        Sent <span className="font-medium">{c.keyword.keyword}</span>{" "}
                        to{" "}
                        <span className={c.username ? "font-medium" : "font-mono text-xs text-muted-foreground"}>
                          {c.username ? `@${c.username}` : c.igUserId}
                        </span>
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelative(c.completedAt ?? c.createdAt)}
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function StatCard({
  icon,
  label,
  value,
  sub,
  delay,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  delay: number;
}) {
  return (
    <motion.div {...fadeUp} transition={{ duration: 0.2, delay }}>
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-muted-foreground">
            {icon}
            <CardDescription className="text-xs uppercase tracking-wide">
              {label}
            </CardDescription>
          </div>
          <CardTitle className="mt-3 text-3xl font-semibold tracking-tight">
            {value}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      </Card>
    </motion.div>
  );
}
