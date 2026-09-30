/** The web page that accepts an invitation; the token travels in the URL fragment, which browsers never send. */
export const INVITATION_ACCEPT_PATH = "/invitations/accept";

/** The link an owner shares, built from the origin the browser is on (never a configured or server URL). */
export function invitationLink(origin: string, token: string): string {
  return `${origin}${INVITATION_ACCEPT_PATH}#token=${encodeURIComponent(token)}`;
}

interface LocationLike {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string): void;
}

/**
 * Reads `#token=...` and immediately removes the whole fragment from the
 * address bar and the current history entry, so the token is not left in
 * the URL, history or a copied link. Returns the token for in-memory use only.
 */
export function takeInvitationToken(location: LocationLike, history: HistoryLike): string | undefined {
  if (location.hash === "") return undefined;
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? undefined;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return token === undefined || token === "" ? undefined : token;
}
