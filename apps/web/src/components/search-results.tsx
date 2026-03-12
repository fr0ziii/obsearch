import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@obsearch/ui/components/card";

export interface SearchResultItem {
  path: string;
  type: "md" | "image" | "pdf" | "other";
  score: number;
}

interface SearchResultsProps {
  results: SearchResultItem[];
  serverUrl: string;
  vaultName: string;
  thumbnailToken: string;
  loading: boolean;
}

export function SearchResults({
  results,
  serverUrl,
  vaultName,
  thumbnailToken,
  loading,
}: SearchResultsProps) {
  if (loading) {
    return <p className="text-xs text-muted-foreground">Searching...</p>;
  }

  if (results.length === 0) {
    return <p className="text-xs text-muted-foreground">No matches found.</p>;
  }

  return (
    <div className="grid gap-3">
      {results.map((result) => {
        const normalizedPath = normalizeRelativePath(result.path);
        const deepLink = buildObsidianDeepLink(vaultName, normalizedPath);
        const thumbnailUrl =
          result.type === "image"
            ? buildVaultFileUrl(serverUrl, normalizedPath, thumbnailToken)
            : null;

        return (
          <Card key={`${result.type}:${result.path}`}>
            {thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt={`Thumbnail for ${normalizedPath}`}
                className="h-40 w-full object-cover bg-muted"
                loading="lazy"
              />
            ) : null}
            <CardHeader>
              <CardTitle className="break-all">{normalizedPath}</CardTitle>
              <CardDescription>
                Type: {result.type} | Score: {result.score.toFixed(6)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a
                className="text-xs underline underline-offset-2"
                href={deepLink}
              >
                Open in Obsidian
              </a>
            </CardContent>
            {thumbnailUrl ? (
              <CardFooter>
                <a
                  className="text-xs underline underline-offset-2"
                  href={thumbnailUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open thumbnail
                </a>
              </CardFooter>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function normalizeRelativePath(path: string): string {
  const withoutBackslashes = path.replaceAll("\\", "/");
  return withoutBackslashes.replace(/^\/+/, "");
}

function buildVaultFileUrl(
  serverUrl: string,
  relativePath: string,
  thumbnailToken: string,
): string {
  const encodedRelativePath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const url = new URL(`/vault-file/${encodedRelativePath}`, serverUrl);
  url.searchParams.set("token", thumbnailToken);
  return url.toString();
}

function buildObsidianDeepLink(vaultName: string, relativePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
}
