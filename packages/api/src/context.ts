import type { CoreDb } from "@obsearch/core";
import type { Context as HonoContext } from "hono";

export type SearchCore = Pick<CoreDb, "search">;

export type CreateContextOptions = {
  context: HonoContext;
  searchCore: SearchCore;
};

export async function createContext({
  context,
  searchCore,
}: CreateContextOptions) {
  void context;
  if (!searchCore) {
    throw new Error(
      "Search dependency is required. Pass searchCore to createContext(...).",
    );
  }

  // No auth configured
  return {
    session: null,
    core: searchCore,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
