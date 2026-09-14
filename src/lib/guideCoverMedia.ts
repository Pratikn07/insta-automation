type FetchLike = typeof fetch;

export function guideCoverHttpPublicUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path}`;
}

export function createGuideCoverHttpBucket(options: {
  baseUrl: string;
  writeToken: string;
  fetchImpl?: FetchLike;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async upload(
      path: string,
      bytes: Buffer,
      uploadOptions: { cacheControl: string; contentType: string; upsert: boolean },
    ) {
      try {
        const body = Uint8Array.from(bytes);
        const response = await fetchImpl(guideCoverHttpPublicUrl(options.baseUrl, path), {
          method: "PUT",
          body,
          headers: {
            authorization: `Bearer ${options.writeToken}`,
            "cache-control": uploadOptions.cacheControl,
            "content-type": uploadOptions.contentType,
            "if-none-match": uploadOptions.upsert ? "" : "*",
          },
        });
        if (response.ok) return { data: { path }, error: null };
        return { data: null, error: { statusCode: response.status } };
      } catch {
        return { data: null, error: { statusCode: 503 } };
      }
    },

    async download(path: string) {
      try {
        const response = await fetchImpl(guideCoverHttpPublicUrl(options.baseUrl, path));
        if (response.ok) return { data: await response.blob(), error: null };
        return { data: null, error: { statusCode: response.status } };
      } catch {
        return { data: null, error: { statusCode: 503 } };
      }
    },

    async remove(paths: string[]) {
      for (const path of paths) {
        try {
          const response = await fetchImpl(guideCoverHttpPublicUrl(options.baseUrl, path), {
            method: "DELETE",
            headers: { authorization: `Bearer ${options.writeToken}` },
          });
          if (!response.ok) return { data: null, error: { statusCode: response.status } };
        } catch {
          return { data: null, error: { statusCode: 503 } };
        }
      }
      return { data: paths, error: null };
    },
  };
}
