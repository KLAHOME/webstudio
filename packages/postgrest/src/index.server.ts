import type { Database } from "./__generated__/db-types";
import { PostgrestClient } from "@supabase/postgrest-js";
export type { Database } from "./__generated__/db-types";

export type Client = PostgrestClient<Database>;

export const createClient = (url: string, apiKey: string): Client => {
  const client = new PostgrestClient<Database>(url, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    // Without this, PostgrestClient falls back to its bundled
    // @supabase/node-fetch (a node-fetch@2 fork), which pools keep-alive
    // sockets through Node's legacy http.Agent. That Agent only notices a
    // server-closed socket reactively (via a 'close'/'error' event) and can
    // lose the race when the server sends its response, then FIN, only a
    // few milliseconds before the next request goes out on the same pooled
    // connection - the request is written to an already-dying socket and
    // the server replies with a bare TCP RST instead of an HTTP response,
    // which the client sees as ECONNRESET ("socket hang up").
    //
    // Confirmed live via a packet capture on 2026-09-10 during a real
    // Nextcloud OIDC login on builder.klahome.de: PostgREST sent a 406 for
    // the `User` select, then FIN four ms later; four point seven ms after
    // that FIN this client reused the same TCP port for the following
    // INSERT, and PostgREST answered with RST. Node's built-in global
    // fetch (undici) does not share this bug - manual reproduction with it
    // always succeeded, which is why isolated testing could not reproduce
    // what only showed up in the real request path using this library's
    // default client.
    fetch,
  });

  return client;
};
