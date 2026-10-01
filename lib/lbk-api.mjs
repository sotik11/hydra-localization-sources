// LBK (lbklauncher.com) REST access, shared by the generator (generators/lbk.mjs)
// and the weekly channel reconciliation (.github/scripts/lbk-channel-check.mjs).
//
// The anon key is LBK's public client key (shipped in their site bundle and
// launcher by design); it only allows the same read access the site itself has.
// LBK rotates it now and then — on 2026-08-09 the embedded key started answering
// 401 and the feed silently froze for two months — so the embedded copy is only
// a first guess: on a 401 the current key is read from the public site bundle.

import { getJson, getText } from "./net.mjs";

export const SUPABASE = "https://supabase.lbklauncher.com";
export const SITE = "https://lbklauncher.com";

const EMBEDDED_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2MjkzMjcxLCJleHAiOjIxMDE2NTMyNzF9.EfWNGG8mp6Ck5HfQBMnWJolQ-ykUMPLwzGsMMlJUuIw";

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** `iat` of a Supabase anon JWT, or -1 if the token is something else. */
function anonIssuedAt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload.role === "anon" && payload.iss === "supabase" ? (payload.iat ?? 0) : -1;
  } catch {
    return -1;
  }
}

/** The anon key the site itself ships to every visitor (newest one in the bundle). */
async function discoverAnonKey() {
  const home = await getText(SITE);
  const chunks = [...new Set(home.match(/\/_next\/static\/chunks\/[^"'\\]+\.js/g) || [])];
  let best = null;
  let bestIat = -1;
  const scan = (text) => {
    for (const key of text.match(JWT_RE) || []) {
      const iat = anonIssuedAt(key);
      if (iat > bestIat) [best, bestIat] = [key, iat];
    }
  };
  scan(home);
  for (const chunk of chunks) {
    try {
      scan(await getText(SITE + chunk));
    } catch {
      // one unreadable chunk is fine as long as the key turns up in another
    }
  }
  if (!best) throw new Error(`[LBK] no anon key found in the site bundle (${chunks.length} chunks scanned)`);
  return best;
}

let anonKey = EMBEDDED_ANON;

/**
 * GET /rest/v1/games?<query>. Uses the embedded key; if it has been rotated
 * (401), switches to the site's current one for the rest of the process.
 * @param {string} query PostgREST query string, e.g. "select=slug&hide=eq.true"
 */
export async function lbkGames(query) {
  const url = `${SUPABASE}/rest/v1/games?${query}`;
  // tries: 1 — a 401 will not get better on a retry.
  const call = (key) =>
    getJson(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, tries: 1 });
  try {
    return await call(anonKey);
  } catch (err) {
    if (!/->\s*401\b/.test(err.message)) throw err;
    // stderr: callers may reserve stdout for their own output
    console.error("[LBK] anon key rejected (401) — reading the current one from the site bundle…");
    anonKey = await discoverAnonKey();
    return call(anonKey);
  }
}
