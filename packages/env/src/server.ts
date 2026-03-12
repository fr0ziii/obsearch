import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2-preview"),
    OBSEARCH_DB_PATH: z.string().min(1),
    OBSEARCH_VAULT_PATH: z.string().trim().min(1),
    OBSEARCH_THUMBNAIL_TOKEN: z.string().trim().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
