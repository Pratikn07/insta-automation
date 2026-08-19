import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { asyncRouter } from "./asyncRouter.js";

const API_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Mirrors the real app: routers are mounted under a parent that owns the error
 * middleware, exactly as `router.ts` does. The assertions are about whether a
 * failure ever *reaches* that middleware.
 */
function mount(build: (router: ReturnType<typeof asyncRouter>) => void) {
  const router = asyncRouter();
  build(router);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}

describe("asyncRouter", () => {
  /**
   * The failure this exists for. Under a plain `Router()` this request is never
   * answered at all — the rejection escapes Express's synchronous `catch`, no
   * response is written, and the socket is held until the client gives up.
   */
  it("answers a rejected async handler instead of leaving the request open", async () => {
    const app = mount((router) => {
      router.delete("/thing", async () => {
        throw Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
      });
    });

    const response = await request(app).delete("/api/thing").expect(500);

    expect(response.body).toEqual({ error: "internal_error" });
  });

  /**
   * Proves the test above measures the wrapper and not something Express does on its
   * own: the same rejection on an unwrapped Router produces no response at all.
   *
   * The handler returns a promise that already carries a `.catch`, which is what an
   * `async` handler's rejection is minus the unhandled-rejection warning. Express 4
   * discards the return value either way, so the request still goes unanswered —
   * this file just does not litter the suite with a stray rejection to show it.
   */
  it("is the reason it gets answered — a plain Router does not", async () => {
    const dropped = Promise.reject(new Error("boom"));
    const observed = dropped.catch((error: Error) => error);

    const bare = express.Router();
    bare.delete("/thing", () => dropped);
    const app = express();
    app.use("/api", bare);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(500).json({ error: "internal_error" });
    });

    // 300ms is not the real deadline; it only has to be long enough to show nothing
    // is coming, without making the suite wait out a 20 second client timeout.
    await expect(
      request(app).delete("/api/thing").timeout({ deadline: 300 }),
    ).rejects.toThrow();
    // The rejection happened; Express simply never acted on it.
    expect((await observed).message).toBe("boom");
  });

  it("still forwards a synchronous throw", async () => {
    const app = mount((router) => {
      router.get("/sync", () => {
        throw new Error("thrown before any await");
      });
    });

    await request(app).get("/api/sync").expect(500);
  });

  it.each(["get", "post", "put", "patch", "delete"] as const)(
    "covers %s",
    async (verb) => {
      const app = mount((router) => {
        router[verb]("/thing", async () => {
          throw new Error("boom");
        });
      });

      await request(app)[verb]("/api/thing").expect(500);
    },
  );

  it("leaves a handler that resolves normally alone", async () => {
    const app = mount((router) => {
      router.get("/ok", async (_req, res) => {
        res.json({ fine: true });
      });
    });

    const response = await request(app).get("/api/ok").expect(200);

    expect(response.body).toEqual({ fine: true });
  });

  // A route that answers itself and *then* rejects must not have `next` called with
  // the error — the response is already sent, and Express would log
  // "Cannot set headers after they are sent". The webhook route has this shape.
  it("does not disturb a response already sent before the rejection", async () => {
    const app = mount((router) => {
      router.post("/ack-then-fail", async (_req, res) => {
        res.sendStatus(202);
        throw new Error("background work failed after the ack");
      });
    });

    await request(app).post("/api/ack-then-fail").expect(202);
  });

  it("wraps every handler in a chain, not only the last", async () => {
    const gate = vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
    );
    const app = mount((router) => {
      router.get("/guarded", gate, async () => {
        throw new Error("boom");
      });
    });

    await request(app).get("/api/guarded").expect(500);
    expect(gate).toHaveBeenCalledOnce();
  });

  /**
   * Error middleware is recognised by arity, so wrapping one into a 3-argument
   * closure would silently demote it to an ordinary handler and every error
   * response it owns would turn into a generic 500.
   */
  it("leaves error middleware's four-argument shape intact", async () => {
    const router = asyncRouter();
    router.get("/boom", async () => {
      throw new Error("boom");
    });
    router.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(418).json({ error: "handled_locally" });
    });
    const app = express();
    app.use("/api", router);

    const response = await request(app).get("/api/boom").expect(418);

    expect(response.body).toEqual({ error: "handled_locally" });
  });

  // Mounting a sub-router must keep working: routers are functions too, so a `use`
  // that wrapped its argument would replace the router with a closure and lose the
  // stack Express walks to match nested paths.
  it("still mounts sub-routers through use", async () => {
    const child = asyncRouter();
    child.get("/leaf", (_req, res) => {
      res.json({ nested: true });
    });
    const app = mount((router) => {
      router.use("/branch", child);
    });

    const response = await request(app).get("/api/branch/leaf").expect(200);

    expect(response.body).toEqual({ nested: true });
  });

  it("keeps route parameters working", async () => {
    const app = mount((router) => {
      router.get("/thing/:id", async (req, res) => {
        res.json({ id: req.params.id });
      });
    });

    const response = await request(app).get("/api/thing/abc123").expect(200);

    expect(response.body).toEqual({ id: "abc123" });
  });
});

/**
 * The wrapper only helps the routers that actually use it.
 *
 * Every test above would still pass if a route file were changed back to a bare
 * `Router()` — the helper would be correct and unused, and that file's 82 sibling
 * handlers would go back to hanging on an unexpected throw. This reads the files.
 */
describe("every route file builds its router through asyncRouter", () => {
  const routeFiles = readdirSync(API_DIR).filter((name) => name.endsWith(".routes.ts"));

  // If this is ever zero the loop below vacuously passes, which would be the one
  // way this guard could stop guarding anything.
  it("found the route files to check", () => {
    expect(routeFiles.length).toBeGreaterThan(15);
  });

  it.each(routeFiles)("%s does not construct a bare Router", (name) => {
    const source = readFileSync(join(API_DIR, name), "utf8");

    expect(source).not.toMatch(/=\s*Router\(\)/);
  });

  /**
   * `router.ts` is the exception, and deliberately so: it mounts sub-routers and
   * owns the error middleware, but serves only one trivial synchronous route. Named
   * here so the exemption is a recorded decision rather than an omission.
   */
  it("exempts router.ts, which has no async handlers of its own", () => {
    const source = readFileSync(join(API_DIR, "router.ts"), "utf8");

    expect(source).toMatch(/=\s*Router\(\)/);
    expect(source).not.toMatch(/apiRouter\.(get|post|put|patch|delete)\([^)]*async/);
  });
});
