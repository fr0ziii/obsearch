import { describe, expect, it, mock } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";

import {
	appRouter,
	type AppRouterClient,
	DEFAULT_SEARCH_LIMIT,
	MAX_SEARCH_LIMIT,
	runSearch,
	searchInputSchema,
} from "./index";
import type { SearchCore } from "../context";

describe("searchInputSchema", () => {
	it("rejects empty queries", () => {
		expect(() => searchInputSchema.parse({ query: "" })).toThrow();
		expect(() => searchInputSchema.parse({ query: "   " })).toThrow();
	});

	it("rejects invalid limits", () => {
		expect(() => searchInputSchema.parse({ query: "ok", limit: 0 })).toThrow();
		expect(() => searchInputSchema.parse({ query: "ok", limit: -1 })).toThrow();
		expect(() => searchInputSchema.parse({ query: "ok", limit: 1.5 })).toThrow();
		expect(() =>
			searchInputSchema.parse({ query: "ok", limit: MAX_SEARCH_LIMIT + 1 }),
		).toThrow();
	});
});

describe("runSearch", () => {
	it("delegates to core.search with default limit", async () => {
		const searchMock = mock(async (query: string, limit: number) => {
			void query;
			void limit;
			return [{ path: "notes/architecture.md", type: "md" as const, score: 0.01 }];
		});
		const core = {
			search: searchMock,
		};
		const input = searchInputSchema.parse({ query: "  architecture  " });

		const results = await runSearch(core, input);

		expect(searchMock).toHaveBeenCalledTimes(1);
		expect(searchMock).toHaveBeenCalledWith("architecture", DEFAULT_SEARCH_LIMIT);
		expect(results).toEqual([
			{ path: "notes/architecture.md", type: "md", score: 0.01 },
		]);
	});

	it("delegates to core.search with explicit limit", async () => {
		const searchMock = mock(async (query: string, limit: number) => {
			void query;
			void limit;
			return [{ path: "images/diagram.png", type: "image" as const, score: 0.2 }];
		});
		const core = {
			search: searchMock,
		};
		const input = searchInputSchema.parse({ query: "diagram", limit: 3 });

		await runSearch(core, input);

		expect(searchMock).toHaveBeenCalledWith("diagram", 3);
	});
});

describe("search route rpc wiring", () => {
	it("validates input and delegates through oRPC handler path", async () => {
		const searchMock = mock(async (query: string, limit: number) => {
			void query;
			void limit;
			return [{ path: "notes/architecture.md", type: "md" as const, score: 0.04 }];
		});
		const client = createRpcTestClient({ search: searchMock });

		const results = await client.search({ query: "  architecture  " });

		expect(searchMock).toHaveBeenCalledTimes(1);
		expect(searchMock).toHaveBeenCalledWith("architecture", DEFAULT_SEARCH_LIMIT);
		expect(results).toEqual([
			{ path: "notes/architecture.md", type: "md", score: 0.04 },
		]);
	});

	it("rejects invalid input before core.search is called", async () => {
		const searchMock = mock(async () => {
			return [];
		});
		const client = createRpcTestClient({ search: searchMock });

		await expect(client.search({ query: "   " })).rejects.toThrow();
		expect(searchMock).not.toHaveBeenCalled();
	});
});

function createRpcTestClient(core: SearchCore): AppRouterClient {
	const rpcHandler = new RPCHandler(appRouter);
	const link = new RPCLink({
		url: "http://localhost/rpc",
		fetch: async (input: Request | URL | string, init?: RequestInit) => {
			const request =
				input instanceof Request
					? input
					: new Request(typeof input === "string" ? input : input.toString(), init);
			const rpcResult = await rpcHandler.handle(request, {
				prefix: "/rpc",
				context: {
					session: null,
					core,
				},
			});

			if (!rpcResult.matched) {
				return new Response("Not Found", { status: 404 });
			}

			return rpcResult.response;
		},
	});

	return createORPCClient(link);
}
