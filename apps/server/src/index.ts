import { createContext } from "@obsearch/api/context";
import { appRouter } from "@obsearch/api/routers/index";
import {
  createEmbeddingClient,
  GEMINI_EMBEDDING_DIMENSION,
  initDb,
  resolveImageMimeType,
} from "@obsearch/core";
import { env } from "@obsearch/env/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const embeddingClient = createEmbeddingClient({
  apiKey: env.GEMINI_API_KEY,
  model: env.GEMINI_EMBEDDING_MODEL,
  expectedDimension: GEMINI_EMBEDDING_DIMENSION,
  outputDimensionality: GEMINI_EMBEDDING_DIMENSION,
});

const coreDb = initDb({
  dbPath: env.OBSEARCH_DB_PATH,
  embeddingDimension: GEMINI_EMBEDDING_DIMENSION,
  embeddingClient,
});
const realVaultRootPath = resolveVaultRootPath(env.OBSEARCH_VAULT_PATH);

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/vault-file/*", async (c) => {
  if (!isLoopbackRequest(c.req.raw)) {
    return c.text("Vault file previews are only available via loopback.", 403);
  }

  const providedToken = extractProvidedThumbnailToken(c.req.raw);
  if (providedToken !== env.OBSEARCH_THUMBNAIL_TOKEN) {
    return c.text("Invalid thumbnail token.", 403);
  }

  const requestedPath = parseRequestedVaultPath(
    extractEncodedVaultPath(c.req.url),
  );
  if (!requestedPath) {
    return c.text("Invalid vault file path.", 400);
  }

  const mimeType = resolveImageMimeType(requestedPath);
  if (!mimeType) {
    return c.text("Unsupported thumbnail file type.", 415);
  }

  const absoluteRequestedPath = resolve(realVaultRootPath, requestedPath);
  if (!isInsideBasePath(realVaultRootPath, absoluteRequestedPath)) {
    return c.text("Requested file is outside vault boundary.", 403);
  }

  let realRequestedPath: string;
  try {
    realRequestedPath = realpathSync(absoluteRequestedPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return c.notFound();
    }

    throw error;
  }

  if (!isInsideBasePath(realVaultRootPath, realRequestedPath)) {
    return c.text("Requested file is outside vault boundary.", 403);
  }

  const stats = statSync(realRequestedPath);
  if (!stats.isFile()) {
    return c.notFound();
  }

  const file = Bun.file(realRequestedPath);
  if (!(await file.exists())) {
    return c.notFound();
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=60",
      "Content-Type": file.type || mimeType,
    },
  });
});

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.use("/*", async (c, next) => {
  const context = await createContext({ context: c, searchCore: coreDb });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: "/api-reference",
    context: context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

app.get("/", (c) => {
  return c.text("OK");
});

function resolveVaultRootPath(vaultPath: string): string {
  const absoluteVaultPath = resolve(vaultPath);
  let resolvedVaultPath: string;
  try {
    resolvedVaultPath = realpathSync(absoluteVaultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OBSEARCH_VAULT_PATH must point to an existing vault directory: ${absoluteVaultPath}. ${message}`,
    );
  }

  const vaultStats = statSync(resolvedVaultPath);
  if (!vaultStats.isDirectory()) {
    throw new Error(
      `OBSEARCH_VAULT_PATH must point to a directory. Received: ${resolvedVaultPath}`,
    );
  }

  return resolvedVaultPath;
}

function extractEncodedVaultPath(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  const routePrefix = "/vault-file/";
  if (!url.pathname.startsWith(routePrefix)) {
    return null;
  }

  return url.pathname.slice(routePrefix.length);
}

function parseRequestedVaultPath(rawPath: string | null): string | null {
  if (!rawPath || rawPath.length === 0) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) {
    return null;
  }

  const normalizedPath = decodedPath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/");
  if (
    pathSegments.length === 0 ||
    pathSegments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }

  return pathSegments.join("/");
}

function isInsideBasePath(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(basePath, candidatePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

function isLoopbackRequest(request: Request): boolean {
  const requestUrlHost = parseHostFromUrl(request.url);
  if (!requestUrlHost || !isLoopbackHost(requestUrlHost)) {
    return false;
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader) {
    const normalizedHostHeader = normalizeHostHeader(hostHeader);
    if (!isLoopbackHost(normalizedHostHeader)) {
      return false;
    }
  }

  const originHeader = request.headers.get("origin");
  if (originHeader) {
    const originHost = parseHostFromUrl(originHeader);
    if (!originHost || !isLoopbackHost(originHost)) {
      return false;
    }
  }

  const forwardedForHeader = request.headers.get("x-forwarded-for");
  if (forwardedForHeader) {
    const forwardedHosts = forwardedForHeader
      .split(",")
      .map((value) => normalizeHostHeader(value))
      .filter((value) => value.length > 0);

    if (forwardedHosts.length === 0 || forwardedHosts.some((host) => !isLoopbackHost(host))) {
      return false;
    }
  }

  return true;
}

function parseHostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function normalizeHostHeader(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }

  if (trimmed.startsWith("[")) {
    const closingBracketIndex = trimmed.indexOf("]");
    if (closingBracketIndex === -1) {
      return trimmed;
    }

    return trimmed.slice(1, closingBracketIndex);
  }

  const firstColonIndex = trimmed.indexOf(":");
  if (firstColonIndex === -1) {
    return trimmed;
  }

  const colonCount = trimmed.split(":").length - 1;
  if (colonCount > 1) {
    return trimmed;
  }

  return trimmed.slice(0, firstColonIndex);
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function extractProvidedThumbnailToken(request: Request): string | null {
  const urlToken = new URL(request.url).searchParams.get("token");
  if (urlToken) {
    return urlToken;
  }

  const headerToken = request.headers.get("x-obsearch-thumbnail-token");
  if (headerToken) {
    return headerToken.trim();
  }

  const authorizationHeader = request.headers.get("authorization");
  if (!authorizationHeader) {
    return null;
  }

  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) {
    return null;
  }

  const bearerToken = authorizationHeader.slice(prefix.length).trim();
  return bearerToken.length > 0 ? bearerToken : null;
}

export default app;
