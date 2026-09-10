import http from "node:http";
import https from "node:https";

// Remix installs web-fetch, whose legacy agent can reuse a server-closed socket.
// Keep PostgREST requests off that pool; never retry potentially committed writes.
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// web-fetch resolves strings, URLs, Requests and redirects before calling this.
const agent = (url: URL) =>
  url.protocol === "https:" ? httpsAgent : httpAgent;

export const fetchWithoutKeepAlive: typeof fetch = (input, init) => {
  // `agent` is web-fetch's Node extension, not a standard RequestInit field.
  // This targets Remix's nativeFetch:false runtime; undici ignores this option.
  const options: RequestInit & { agent: typeof agent } = { ...init, agent };
  return fetch(input, options);
};
