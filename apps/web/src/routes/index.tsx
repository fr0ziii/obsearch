import { Button } from "@obsearch/ui/components/button";
import { Input } from "@obsearch/ui/components/input";
import { Label } from "@obsearch/ui/components/label";
import { env } from "@obsearch/env/web";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";

import {
  SearchResults,
  type SearchResultItem,
} from "@/components/search-results";
import { client, orpc } from "@/utils/orpc";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

function HomeComponent() {
  const healthCheck = useQuery(orpc.healthCheck.queryOptions());
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const queryInputId = useId();
  const limitInputId = useId();
  const latestSearchRequestId = useRef(0);

  const submitSearch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      setValidationError("Query cannot be empty.");
      return;
    }

    const normalizedLimit = limit.trim();
    let parsedLimit: number | undefined;
    if (normalizedLimit.length > 0) {
      const numericLimit = Number(normalizedLimit);
      if (
        !Number.isInteger(numericLimit) ||
        numericLimit <= 0 ||
        numericLimit > MAX_SEARCH_LIMIT
      ) {
        setValidationError(
          `Limit must be a whole number between 1 and ${MAX_SEARCH_LIMIT}.`,
        );
        return;
      }

      parsedLimit = numericLimit;
    }

    setValidationError(null);
    setSubmittedQuery(normalizedQuery);
    setSearchError(null);
    setResultsQuery(null);
    setResults([]);
    setIsSearching(true);

    const requestId = latestSearchRequestId.current + 1;
    latestSearchRequestId.current = requestId;

    try {
      const searchResults = await client.search({
        query: normalizedQuery,
        limit: parsedLimit,
      });
      if (latestSearchRequestId.current !== requestId) {
        return;
      }

      setResults(searchResults);
      setResultsQuery(normalizedQuery);
    } catch (error) {
      if (latestSearchRequestId.current !== requestId) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unexpected error.";
      setSearchError(errorMessage);
      setResults([]);
      setResultsQuery(null);
    } finally {
      if (latestSearchRequestId.current === requestId) {
        setIsSearching(false);
      }
    }
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-2">
      <pre className="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
      <div className="grid gap-6">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">API Status</h2>
          <div className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${healthCheck.data ? "bg-green-500" : "bg-red-500"}`}
            />
            <span className="text-sm text-muted-foreground">
              {healthCheck.isLoading
                ? "Checking..."
                : healthCheck.data
                  ? "Connected"
                  : "Disconnected"}
            </span>
          </div>
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">Search Vault</h2>
          <form className="grid gap-3" onSubmit={submitSearch}>
            <div className="grid gap-1.5">
              <Label htmlFor={queryInputId}>Query</Label>
              <Input
                id={queryInputId}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="e.g. architecture diagram"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={limitInputId}>
                Limit (optional, default {DEFAULT_SEARCH_LIMIT})
              </Label>
              <Input
                id={limitInputId}
                type="number"
                min={1}
                max={MAX_SEARCH_LIMIT}
                step={1}
                value={limit}
                onChange={(event) => setLimit(event.currentTarget.value)}
                placeholder={String(DEFAULT_SEARCH_LIMIT)}
                inputMode="numeric"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={isSearching}>
                {isSearching ? "Searching..." : "Search"}
              </Button>
              {submittedQuery ? (
                <span className="text-xs text-muted-foreground">
                  Last query: {submittedQuery}
                </span>
              ) : null}
            </div>
          </form>
          {validationError ? (
            <p className="mt-2 text-xs text-destructive">{validationError}</p>
          ) : null}
          {searchError ? (
            <p className="mt-2 text-xs text-destructive">
              Search failed for "{submittedQuery}": {searchError}
            </p>
          ) : null}
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">Results</h2>
          {submittedQuery ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Query: {submittedQuery}
              </p>
              {searchError ? null : (
                <SearchResults
                  results={
                    resultsQuery === submittedQuery
                      ? results
                      : []
                  }
                  serverUrl={env.VITE_SERVER_URL}
                  vaultName={env.VITE_OBSIDIAN_VAULT_NAME}
                  thumbnailToken={env.VITE_OBSEARCH_THUMBNAIL_TOKEN}
                  loading={isSearching}
                />
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Submit a query to search indexed notes, images, and PDFs.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
