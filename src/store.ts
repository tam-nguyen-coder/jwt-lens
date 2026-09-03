/* ---------------------------------------------------------------------------
   What the panel remembers.

   Deliberately in memory only. Every other tool in dev-tools/ restores the whole
   session from localStorage, and here that would be wrong: these are live
   credentials, and a token sitting in a browser profile long after the tab was
   closed is a liability the tool has no business creating. Layout and theme
   persist; token values never do.
   --------------------------------------------------------------------------- */

import { decodeJwt, isJwt } from "./jwt.ts";
import type { Jwt } from "./jwt.ts";
import { extractTokens } from "./extract.ts";
import type { RequestFacts, Where } from "./extract.ts";

export interface Sighting {
  /** Epoch milliseconds. */
  at: number;
  method: string;
  url: string;
  status: number;
  where: Where;
  detail: string;
}

/**
 * What the panel actually saw. Kept so an empty list can explain itself: on a
 * busy app "no tokens" has several very different causes, and guessing between
 * them from the outside is exactly the thing this tool exists to avoid.
 */
export interface Diagnostics {
  requests: number;
  /** Requests that arrived carrying any request headers at all. */
  withHeaders: number;
  withAuthHeader: number;
  /** Authorization values using a Bearer/JWT scheme. */
  withBearer: number;
  /** Requests where something JWT-shaped appeared anywhere. */
  jwtShaped: number;
  /** JWT-shaped but rejected by the decoder — that would be a bug here. */
  rejected: number;
  /** Distinct request header names seen, most frequent first. */
  headerNames: string[];
  /** Hosts the requests went to, most frequent first. */
  hosts: string[];
  /** Chrome's resource types with their counts, e.g. "xhr 60". */
  resourceTypes: string[];
}

export interface Entry {
  token: string;
  jwt: Jwt;
  first: number;
  last: number;
  /** How many requests carried this token. */
  count: number;
  wheres: Where[];
  /** Most recent first, capped — a token on a polling endpoint would grow forever. */
  sightings: Sighting[];
}

/** Tokens issued to the same identity by the same issuer, oldest first. */
export interface Chain {
  key: string;
  label: string;
  entries: Entry[];
}

const SIGHTINGS_MAX = 40;

/**
 * Which tokens are "the same session at different times". Rotation is the thing
 * you actually want to see — the second token is not a new user, it is the
 * refresh that replaced the first.
 */
export function identityOf(jwt: Jwt): string {
  return [jwt.iss ?? "", jwt.sub ?? "", jwt.aud ?? "", jwt.alg].join("|");
}

export class TokenStore {
  private byToken = new Map<string, Entry>();
  /** Requests seen, whether or not they carried a token — the denominator. */
  requests = 0;
  withTokens = 0;
  private diag = { withHeaders: 0, withAuthHeader: 0, withBearer: 0, jwtShaped: 0, rejected: 0 };
  private headerCounts = new Map<string, number>();
  private seenIds = new Set<string>();
  private hostCounts = new Map<string, number>();
  private typeCounts = new Map<string, number>();

  /** Feed one request in; returns the entries that are new or newly updated. */
  add(facts: RequestFacts): Entry[] {
    // A response body arrives after the request it belongs to, under the same
    // id. That is the same request knowing more about itself, not a new one.
    const amendment = facts.id !== undefined && this.seenIds.has(facts.id);
    if (facts.id !== undefined) this.seenIds.add(facts.id);
    if (!amendment) this.requests++;
    const shaped = this.observe(facts, amendment);
    const found = extractTokens(facts);
    if (found.length === 0) {
      if (shaped && !amendment) this.diag.rejected++;
      return [];
    }
    if (!amendment) this.withTokens++;

    const touched: Entry[] = [];
    for (const hit of found) {
      const decoded = decodeJwt(hit.token);
      // A shape that decodes to nothing is not worth a row; findTokens has
      // already filtered these out, so this is belt and braces.
      if (!isJwt(decoded)) continue;

      const sighting: Sighting = {
        at: facts.startedAt,
        method: facts.method,
        url: facts.url,
        status: facts.status,
        where: hit.where,
        detail: hit.detail,
      };

      const existing = this.byToken.get(hit.token);
      if (existing) {
        existing.last = Math.max(existing.last, facts.startedAt);
        existing.first = Math.min(existing.first, facts.startedAt);
        existing.count++;
        if (!existing.wheres.includes(hit.where)) existing.wheres.push(hit.where);
        existing.sightings.unshift(sighting);
        if (existing.sightings.length > SIGHTINGS_MAX) existing.sightings.length = SIGHTINGS_MAX;
        if (!touched.includes(existing)) touched.push(existing);
        continue;
      }

      const entry: Entry = {
        token: hit.token,
        jwt: decoded,
        first: facts.startedAt,
        last: facts.startedAt,
        count: 1,
        wheres: [hit.where],
        sightings: [sighting],
      };
      this.byToken.set(hit.token, entry);
      touched.push(entry);
    }
    return touched;
  }

  /** Record what a request looked like, so an empty list can say why. */
  private observe(facts: RequestFacts, amendment = false): boolean {
    const headers = facts.requestHeaders;
    if (amendment) {
      // Only the body is new; counting the rest again would inflate everything.
      return (facts.responseBody?.includes("eyJ") ?? false);
    }
    if (headers.length > 0) this.diag.withHeaders++;
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (this.headerCounts.size < 200 || this.headerCounts.has(name)) {
        this.headerCounts.set(name, (this.headerCounts.get(name) ?? 0) + 1);
      }
    }
    let host = "?";
    try { host = new URL(facts.url).host; } catch { /* keep the placeholder */ }
    this.hostCounts.set(host, (this.hostCounts.get(host) ?? 0) + 1);
    const type = facts.resourceType ?? "unknown";
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);

    const auth = headers.find((h) => {
      const n = h.name.toLowerCase();
      return n === "authorization" || n === "proxy-authorization";
    });
    if (auth) {
      this.diag.withAuthHeader++;
      if (/^\s*(bearer|jwt)\s+/i.test(auth.value)) this.diag.withBearer++;
    }
    const shaped = headers.some((h) => h.value.includes("eyJ"))
      || facts.url.includes("eyJ")
      || (facts.requestBody?.includes("eyJ") ?? false)
      || (facts.responseBody?.includes("eyJ") ?? false);
    if (shaped) this.diag.jwtShaped++;
    return shaped;
  }

  diagnostics(): Diagnostics {
    const byCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return {
      requests: this.requests,
      ...this.diag,
      headerNames: byCount(this.headerCounts).map(([name]) => name),
      hosts: byCount(this.hostCounts).map(([host, n]) => `${host} ${n}`),
      resourceTypes: byCount(this.typeCounts).map(([type, n]) => `${type} ${n}`),
    };
  }

  /** A token typed or pasted by hand, with no request behind it. */
  addRaw(raw: string, at: number): Entry | null {
    const decoded = decodeJwt(raw);
    if (!isJwt(decoded)) return null;
    const existing = this.byToken.get(decoded.raw);
    if (existing) { existing.last = at; existing.count++; return existing; }
    const entry: Entry = {
      token: decoded.raw, jwt: decoded, first: at, last: at, count: 1, wheres: [], sightings: [],
    };
    this.byToken.set(decoded.raw, entry);
    return entry;
  }

  get(token: string): Entry | undefined { return this.byToken.get(token); }
  get size(): number { return this.byToken.size; }

  /** Newest first — the token you are debugging is almost always the last one. */
  list(): Entry[] {
    return [...this.byToken.values()].sort((a, b) => b.last - a.last);
  }

  /**
   * Group into rotation chains, oldest token first inside each chain, and the
   * chains themselves newest first. A lone token is a chain of one.
   */
  chains(): Chain[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.list()) {
      const key = identityOf(entry.jwt);
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }
    return [...groups.entries()]
      .map(([key, entries]) => {
        entries.sort((a, b) => (a.jwt.iat ?? a.first / 1000) - (b.jwt.iat ?? b.first / 1000));
        return { key, label: entries[0]!.jwt.sub ?? entries[0]!.jwt.iss ?? "unidentified", entries };
      })
      .sort((a, b) => b.entries[b.entries.length - 1]!.last - a.entries[a.entries.length - 1]!.last);
  }

  clear() {
    this.byToken.clear();
    this.requests = 0;
    this.withTokens = 0;
    this.diag = { withHeaders: 0, withAuthHeader: 0, withBearer: 0, jwtShaped: 0, rejected: 0 };
    this.headerCounts.clear();
    this.hostCounts.clear();
    this.typeCounts.clear();
    this.seenIds.clear();
  }
}
