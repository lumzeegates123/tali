/**
 * A scripted Tali API at the fetch boundary for client tests. Routes are
 * "METHOD /path" (query ignored); each route answers from a queue of replies,
 * repeating the last one. Every request is recorded with its headers and body.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type Reply =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "network" }
  | { readonly kind: "deferred"; readonly promise: Promise<Response> };

export const TOKEN = "local-test-access-token.header.signature";
export const USER = { id: "0191a1b2-0000-7000-8000-000000000001", displayName: "Ada Obi" };
export const BUSINESS_A = {
  id: "0191a1b2-0000-7000-8000-00000000000a",
  name: "Ada Provisions",
  currencyCode: "NGN",
  timeZone: "Africa/Lagos",
};
export const BUSINESS_B = {
  id: "0191a1b2-0000-7000-8000-00000000000b",
  name: "Obi General Store",
  currencyCode: "NGN",
  timeZone: "Africa/Lagos",
};
export const LOCATION_A = {
  id: "0191a1b2-0000-7000-8000-0000000000a1",
  name: "Ada Provisions",
  isDefault: true,
  status: "ACTIVE",
};
export const MEMBERSHIP_A = { id: "0191a1b2-0000-7000-8000-0000000000a2", role: "OWNER" };

export function json(status: number, body: unknown): Reply {
  return { kind: "json", status, body };
}

export function apiError(status: number, code: string, message = "Rejected", details?: unknown): Reply {
  return json(status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

export const networkError: Reply = { kind: "network" };

export function deferred(): { reply: Reply; resolve: (status: number, body: unknown) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return {
    reply: { kind: "deferred", promise },
    resolve: (status, body) => {
      resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    },
  };
}

export class FakeTaliApi {
  readonly requests: RecordedRequest[] = [];
  readonly #routes = new Map<string, Reply[]>();

  on(route: string, ...replies: Reply[]): this {
    this.#routes.set(route, replies);
    return this;
  }

  /** Requests to one route, in order. */
  to(route: string): RecordedRequest[] {
    return this.requests.filter((request) => `${request.method} ${request.path}` === route);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.href);
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    this.requests.push({
      method,
      path: url.pathname,
      query: url.search,
      headers: new Headers(init?.headers),
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    });
    const key = `${method} ${url.pathname}`;
    const queue = this.#routes.get(key);
    const reply = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `no fake route ${key}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    switch (reply.kind) {
      case "network":
        throw new TypeError("fetch failed");
      case "deferred":
        return reply.promise;
      case "json":
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        });
    }
  };
}

/** A fake API for a registered user with the given businesses and business A's detail routes. */
export function registeredUserApi(businesses: readonly (typeof BUSINESS_A)[] = [BUSINESS_A]): FakeTaliApi {
  return new FakeTaliApi()
    .on(
      "POST /__local/sign-in",
      json(200, { accessToken: TOKEN, tokenType: "Bearer", expiresAt: "2026-09-30T14:00:00.000Z" }),
    )
    .on("GET /v1/me", json(200, USER))
    .on(
      "GET /v1/me/businesses",
      json(200, { items: businesses.map((business) => ({ business, membership: MEMBERSHIP_A })), nextCursor: null }),
    )
    .on(`GET /v1/businesses/${BUSINESS_A.id}`, json(200, BUSINESS_A))
    .on(`GET /v1/businesses/${BUSINESS_A.id}/locations`, json(200, { items: [LOCATION_A], nextCursor: null }))
    .on(
      `GET /v1/businesses/${BUSINESS_A.id}/members`,
      json(200, {
        items: [{ id: MEMBERSHIP_A.id, displayName: USER.displayName, role: "OWNER", status: "ACTIVE" }],
        nextCursor: null,
      }),
    );
}

export function createdBusinessBody() {
  return {
    business: BUSINESS_A,
    defaultLocation: LOCATION_A,
    membership: { ...MEMBERSHIP_A, status: "ACTIVE" },
  };
}

/** Lets pending fetch and promise callbacks run. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
