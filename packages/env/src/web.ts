import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_SERVER_URL: z.url(),
    VITE_OBSIDIAN_VAULT_NAME: z.string().trim().min(1),
    VITE_OBSEARCH_THUMBNAIL_TOKEN: z.string().trim().min(1),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
