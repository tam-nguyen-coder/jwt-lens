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

  /** Feed one request in; returns the entries that are new or newly updated. */
  add(facts: RequestFacts): Entry[] {
    this.requests++;
    const found = extractTokens(facts);
    if (found.length === 0) return [];
    this.withTokens++;

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
  }
}
