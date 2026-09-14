import { createGuideCoverHttpBucket, guideCoverHttpPublicUrl } from "./guideCoverMedia.js";
import { publicMediaUrl, serverMediaBucket } from "./supabase.js";

export function guideCoverMediaBucket() {
  const baseUrl = process.env.GUIDE_COVER_MEDIA_BASE_URL;
  const writeToken = process.env.GUIDE_COVER_MEDIA_WRITE_TOKEN;
  if (baseUrl && writeToken) {
    return createGuideCoverHttpBucket({
      baseUrl,
      writeToken,
    });
  }
  return serverMediaBucket();
}

export function guideCoverPublicUrl(path: string): string {
  const baseUrl = process.env.GUIDE_COVER_MEDIA_BASE_URL;
  return baseUrl
    ? guideCoverHttpPublicUrl(baseUrl, path)
    : publicMediaUrl(path);
}
