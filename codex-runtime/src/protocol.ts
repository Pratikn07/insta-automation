import type { Readable, Writable } from "node:stream";

export type JsonRpcId = number;
export type RpcRequestHandler = (params: unknown) => Promise<unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcError {
  code: number;
  message: string;
}

export class JsonRpcPeer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  readonly #requestHandlers = new Map<string, RpcRequestHandler>();
  readonly #settledResponseIds = new Set<JsonRpcId>();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.#input = input as Readable;
    this.#output = output as Writable;
    this.#input.setEncoding("utf8");
    this.#input.on("data", this.#handleData);
    this.#input.once("end", this.#handleStreamClose);
    this.#input.once("close", this.#handleStreamClose);
    this.#input.once("error", this.#handleStreamError);
    this.#output.once("error", this.#handleStreamError);
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("app-server peer is closed"));

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.#notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.#notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#notificationHandlers.delete(method);
    };
  }

  onRequest(method: string, handler: RpcRequestHandler): () => void {
    this.#requestHandlers.set(method, handler);
    return () => {
      if (this.#requestHandlers.get(method) === handler) this.#requestHandlers.delete(method);
    };
  }

  close(error = new Error("app-server peer closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#input.off("data", this.#handleData);
  }

  readonly #handleData = (chunk: string | Buffer): void => {
    this.#buffer += String(chunk);
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#handleLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  };

  readonly #handleStreamClose = (): void => {
    this.close(new Error("app-server stream closed"));
  };

  readonly #handleStreamError = (error: Error): void => {
    this.close(error);
  };

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.close(new Error("app-server sent invalid JSON"));
      return;
    }

    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "number" && ("result" in record || "error" in record) && !("method" in record)) {
      this.#handleResponse(record.id, record.result, record.error);
      return;
    }
    if (typeof record.method !== "string") return;
    if (typeof record.id === "number") {
      void this.#handleServerRequest(record.id, record.method, record.params);
      return;
    }
    for (const handler of this.#notificationHandlers.get(record.method) ?? []) {
      handler(record.params);
    }
  }

  #handleResponse(id: JsonRpcId, result: unknown, errorValue: unknown): void {
    if (this.#settledResponseIds.has(id)) {
      this.close(new Error(`app-server sent duplicate response id ${id}`));
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) return;

    this.#pending.delete(id);
    this.#settledResponseIds.add(id);
    clearTimeout(pending.timer);
    if (errorValue && typeof errorValue === "object") {
      const rpcError = errorValue as Partial<RpcError>;
      pending.reject(new Error(`${pending.method} failed: ${rpcError.message ?? "unknown app-server error"}`));
      return;
    }
    pending.resolve(result);
  }

  async #handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#requestHandlers.get(method);
    if (!handler) {
      this.#write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.#write({ id, result });
    } catch (error) {
      this.#write({
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Request handler failed",
        },
      });
    }
  }

  #write(message: unknown): void {
    if (this.#closed) return;
    const chunk = `${JSON.stringify(message)}\n`;
    this.#writeQueue = this.#writeQueue
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            this.#output.write(chunk, (error) => (error ? reject(error) : resolve()));
          }),
      )
      .catch((error: unknown) => {
        this.close(error instanceof Error ? error : new Error("app-server write failed"));
      });
  }
}
