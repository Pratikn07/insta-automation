interface Env {
  MEDIA: R2Bucket;
  GUIDE_COVER_WRITE_TOKEN: string;
}

function objectKey(request: Request): string | null {
  const key = new URL(request.url).pathname.replace(/^\/+/, "");
  return key.startsWith("guide-cover/") || key === "canary/health.png" ? key : null;
}

function publicHeaders(object: R2ObjectBody | R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = objectKey(request);
    if (!key) return new Response("Not found", { status: 404 });

    if (request.method === "GET" || request.method === "HEAD") {
      const object = request.method === "HEAD" ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, {
        status: 200,
        headers: publicHeaders(object),
      });
    }

    if (request.method === "PUT") {
      const expected = `Bearer ${env.GUIDE_COVER_WRITE_TOKEN}`;
      if (!env.GUIDE_COVER_WRITE_TOKEN || request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.headers.get("content-type") !== "image/png") {
        return new Response("PNG required", { status: 415 });
      }
      if (request.headers.get("if-none-match") === "*" && (await env.MEDIA.head(key))) {
        return new Response("Already exists", { status: 409 });
      }
      await env.MEDIA.put(key, request.body, {
        httpMetadata: {
          contentType: "image/png",
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      return new Response(null, { status: 201 });
    }

    if (request.method === "DELETE") {
      const expected = `Bearer ${env.GUIDE_COVER_WRITE_TOKEN}`;
      if (!env.GUIDE_COVER_WRITE_TOKEN || request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      await env.MEDIA.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, PUT, DELETE" } });
  },
};
