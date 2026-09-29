/** A fetch double returning a fixed JSON response; records requests. */
export function jsonFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: typeof fetch; requests: { url: string; init: RequestInit | undefined }[] } {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchDouble: typeof fetch = (input, init) => {
    requests.push({ url: typeof input === "string" ? input : input instanceof Request ? input.url : input.href, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
  return { fetch: fetchDouble, requests };
}

/** A fetch double that fails like an unreachable host. */
export const unreachableFetch: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));

/** A fetch double that never answers until aborted. */
export const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });

/** A fetch double that resolves only when released, for observing the loading state. */
export function deferredFetch(): { fetch: typeof fetch; release: (response: Response) => void } {
  let release: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return {
    fetch: () => pending,
    release: (response) => {
      release(response);
    },
  };
}
