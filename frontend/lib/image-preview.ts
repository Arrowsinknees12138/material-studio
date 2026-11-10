import { fetchImage } from "./api";

export function loadImagePreview(url: string, username: string, ready: (src: string) => void,
  failed: (error: unknown) => void) {
  const controller = new AbortController();
  let objectUrl: string | undefined;
  void fetchImage(url, { signal: controller.signal, headers: { "X-Studio-Account": username } })
    .then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      ready(objectUrl);
    }).catch((error) => {
      if (!controller.signal.aborted) failed(error);
    });
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
