import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { installGlobals } from "@remix-run/node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClient } from "@webstudio-is/postgrest/index.server";
import { fetchWithoutKeepAlive } from "../../../../../packages/postgrest/src/postgrest-fetch.server";

const globals = { fetch, Headers, Request, Response, FormData, File };

beforeEach(() => {
  // Match remix-serve with this app's v3_singleFetch:false, not Node's fetch.
  installGlobals({ nativeFetch: false });
  expect(globalThis.fetch).not.toBe(globals.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(globalThis, globals);
});

const listen = async (server: http.Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const close = async (server: http.Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
};

test.each(["close", "keep-alive"])(
  "Remix GET 406 → POST 201 uses fresh sockets with Connection: %s",
  async (connection) => {
    const sockets: Socket[] = [];
    const requests: Array<{
      method?: string;
      auth?: string;
      key?: string;
      body: string;
    }> = [];
    const server = http.createServer(async (req, res) => {
      sockets.push(req.socket);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      requests.push({
        method: req.method,
        auth: req.headers.authorization,
        key: req.headers.apikey as string,
        body,
      });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Connection", connection);
      res.statusCode = req.method === "GET" ? 406 : 201;
      res.end(
        JSON.stringify(
          req.method === "GET"
            ? { code: "PGRST116", message: "No rows", details: "", hint: "" }
            : { id: "fixture-user", email: "fixture@example.invalid" }
        )
      );
    });
    const url = await listen(server);
    try {
      const client = createClient(url, "fixture-only-key");
      for (let i = 0; i < 30; i++) {
        const missing = await client
          .from("User")
          .select("*")
          .eq("email", "fixture@example.invalid")
          .single();
        expect(missing.status).toBe(406);
        expect(missing.error?.code).toBe("PGRST116");
        // No delay: exercise the immediate read → write boundary.
        const inserted = await client
          .from("User")
          .insert({ id: "fixture-user", email: "fixture@example.invalid" })
          .select()
          .single();
        expect(inserted.error).toBeNull();
        expect(inserted.status).toBe(201);
        expect(inserted.data?.id).toBe("fixture-user");
      }
      expect(requests).toHaveLength(60);
      expect(new Set(sockets).size).toBe(60);
      for (const [index, request] of requests.entries()) {
        expect(request.method).toBe(index % 2 === 0 ? "GET" : "POST");
        expect(request.auth).toBe("Bearer fixture-only-key");
        expect(request.key).toBe("fixture-only-key");
        if (request.method === "POST") {
          expect(JSON.parse(request.body).email).toBe(
            "fixture@example.invalid"
          );
        }
      }
    } finally {
      await close(server);
    }
  }
);

test("accepts string, URL and Remix Request inputs including redirects", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/ok", Connection: "close" });
      res.end();
    } else {
      res.end("ok");
    }
  });
  const url = await listen(server);
  try {
    for (const input of [
      url,
      new URL(url),
      new Request(url),
      new Request(`${url}/redirect`),
    ]) {
      expect(await (await fetchWithoutKeepAlive(input)).text()).toBe("ok");
    }
  } finally {
    await close(server);
  }
});

test("selects non-pooling HTTP/HTTPS agents without relaxing TLS or request options", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("ok"));
  const signal = new AbortController().signal;
  const init = {
    method: "POST",
    body: "payload",
    signal,
    headers: { "x-fixture": "yes" },
    redirect: "error" as const,
  };
  const input = new Request("https://example.invalid/");
  await fetchWithoutKeepAlive(input, init);
  const [actualInput, options] = spy.mock.calls[0];
  expect(actualInput).toBe(input);
  expect(options).toMatchObject(init);
  const { agent } = options as RequestInit & {
    agent: (url: URL) => http.Agent | https.Agent;
  };
  const plain = agent(new URL("http://example.invalid/"));
  const secure = agent(new URL("https://example.invalid/"));
  expect(plain).toBeInstanceOf(http.Agent);
  expect(secure).toBeInstanceOf(https.Agent);
  expect(plain.options.keepAlive).toBe(false);
  expect(secure.options.keepAlive).toBe(false);
  expect(secure.options.rejectUnauthorized).not.toBe(false);
  expect(agent(new URL("https://example.invalid/redirect"))).toBe(secure);
});

test("propagates cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchWithoutKeepAlive("http://127.0.0.1:1", { signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("does not retry a POST when the server drops the response", async () => {
  let writes = 0;
  const server = http.createServer(async (req) => {
    for await (const _chunk of req) {
      /* consume the write before dropping the response */
    }
    writes++;
    req.socket.destroy();
  });
  const url = await listen(server);
  try {
    const result = await createClient(url, "fixture-only-key")
      .from("User")
      .insert({ id: "fixture-user" });
    expect(result.error).not.toBeNull();
    expect(result.status).toBe(0);
    expect(writes).toBe(1);
  } finally {
    await close(server);
  }
});
