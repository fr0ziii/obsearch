import { itemKindSchema } from "@obsearch/core";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";

import type { SearchCore } from "../context";
import { publicProcedure } from "../index";

const searchResultSchema = z.object({
  path: z.string().min(1),
  type: itemKindSchema,
  score: z.number(),
});

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export const searchInputSchema = z.object({
  query: z.string().trim().min(1, "Query cannot be empty."),
  limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export async function runSearch(
  core: SearchCore,
  input: SearchInput,
): Promise<z.infer<typeof searchResultSchema>[]> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  return core.search(input.query, limit);
}

export const appRouter = {
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  search: publicProcedure
    .input(searchInputSchema)
    .output(z.array(searchResultSchema))
    .handler(async ({ context, input }) => {
      return runSearch(context.core, input);
    }),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
