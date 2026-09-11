/**
 * Production server for the self-hosted Builder.
 *
 * `remix-serve` never enables Express's `trust proxy`, so `req.protocol` is
 * always "http" behind Traefik's TLS termination. @remix-run/express builds
 * the request URL as `${req.protocol}://${host}${originalUrl}`, so the app saw
 * every request as http://. That broke Webstudio's own OAuth when opening a
 * project: oauth.ws.authorize compares the request's authorization-server
 * origin against the redirect_uri's, and parseBuilderUrl forces the redirect's
 * origin to https. Comparing http://builder.klahome.de with
 * https://builder.klahome.de failed with
 * "The redirect_uri provided does not match the registered redirect URIs."
 *
 * This is the documented Remix escape hatch: same handler, own Express app, so
 * the only behavioural change is honouring the proxy's X-Forwarded-* headers.
 * Kept intentionally dependency-free beyond express (already a dependency): no
 * compression/morgan, to avoid adding packages to the self-host image.
 */
import { createRequestHandler } from "@remix-run/express";
import express from "express";

const BUILD_PATH = process.env.SERVER_BUILD_PATH;
if (!BUILD_PATH) {
  console.error("SERVER_BUILD_PATH is required");
  process.exit(1);
}

const build = await import(BUILD_PATH);
const app = express();

// Traefik is the only ingress and always sets X-Forwarded-Proto. Trusting one
// hop keeps req.protocol honest without accepting headers from arbitrary
// upstreams.
app.set("trust proxy", 1);

app.disable("x-powered-by");

app.use(express.static("build/client", { maxAge: "1h" }));
app.use(express.static("public", { maxAge: "1h" }));

app.all(
  "*",
  createRequestHandler({ build, mode: process.env.NODE_ENV ?? "production" })
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[express-serve] http://localhost:${port} (trust proxy enabled)`);
});
