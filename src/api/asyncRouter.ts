/**
 * A Router whose async handlers cannot fail silently.
 *
 * Express 4 invokes a handler inside a `try`/`catch`, which catches a *synchronous*
 * throw and forwards it to the error middleware. An `async` handler does not throw
 * synchronously — it returns a promise — so a rejection escapes that `catch`
 * entirely. Express never learns the request failed, so it never answers it. The
 * socket stays open until the client's own deadline expires, and the browser reports
 * a timeout rather than the error that actually happened.
 *
 * That is not a theoretical concern: `DELETE /resources/:id` hit a foreign-key
 * constraint it did not expect and the console showed a bare "Delete failed" twenty
 * seconds later, with nothing to say the delete had been refused or why.
 *
 * Every route file builds its router here instead of calling `Router()`, so the
 * behaviour is one decision rather than 82 `try`/`catch` blocks that a new route can
 * forget to copy. Rejections reach the error middleware in `router.ts` and become an
 * honest 500.
 *
 * Only the HTTP verb methods are wrapped. `use` is left alone deliberately: it
 * mounts sub-routers, which are themselves functions, and rewrapping one would
 * replace the router object with a plain closure and lose the `stack` that Express
 * walks for parameter handling and path mounting.
 */
import { Router, type IRouter, type RequestHandler } from "express";

/** The methods that take route handlers. Deliberately excludes `use`. */
const VERBS = ["get", "post", "put", "patch", "delete", "all"] as const;

/**
 * Hand a rejected promise to `next` so Express sees the failure.
 *
 * Arity of four or more means error-handling middleware, whose contract is
 * `(err, req, res, next)`. Wrapping one would change its shape and stop Express
 * recognising it as an error handler, so it is returned untouched.
 */
function forwardRejections(handler: RequestHandler): RequestHandler {
  if (handler.length >= 4) return handler;
  return function withForwardedRejections(req, res, next) {
    let result: unknown;
    try {
      result = handler(req, res, next);
    } catch (error) {
      // A synchronous throw. Express would have caught this itself; forwarding it
      // here keeps both paths identical rather than depending on which one ran.
      next(error);
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(next);
    }
  };
}

/** Drop-in replacement for `Router()` for any router that serves requests. */
export function asyncRouter(): IRouter {
  const router = Router();
  for (const verb of VERBS) {
    const register = router[verb].bind(router) as (...args: unknown[]) => unknown;
    router[verb] = ((...args: unknown[]) =>
      register(
        ...args.map((arg) =>
          typeof arg === "function" ? forwardRejections(arg as RequestHandler) : arg,
        ),
      )) as IRouter[typeof verb];
  }
  return router;
}
