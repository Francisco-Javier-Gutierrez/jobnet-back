/**
 * OpenSearch Client Helper with Automatic Fallback for DynamoDB
 */

export interface OpenSearchQueryOptions {
  index: string;
  query?: string;
  filters?: Record<string, any>;
  page?: number;
  limit?: number;
}

export interface OpenSearchResult<T = any> {
  hits: T[];
  total: number;
  page: number;
  totalPages: number;
  source: "opensearch" | "dynamodb";
}

/**
 * Executes a search query using OpenSearch Service if OPENSEARCH_ENDPOINT environment variable is set.
 * Otherwise, falls back gracefully to DynamoDB in-memory/scan filtering.
 */
export async function searchOpenSearchOrFallback<T>(
  options: OpenSearchQueryOptions,
  fallbackExecutor: () => Promise<T[]>,
): Promise<OpenSearchResult<T>> {
  const endpoint = process.env.OPENSEARCH_ENDPOINT;
  const isOffline = process.env.IS_OFFLINE === "true";
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));

  const isLocalHost =
    !endpoint ||
    endpoint.includes("localhost") ||
    endpoint.includes("127.0.0.1") ||
    endpoint.includes("mock-opensearch");

  if (endpoint && !isOffline && !isLocalHost) {
    try {
      const url = `https://${endpoint}/${options.index}/_search`;
      const mustClauses: any[] = [];

      if (options.query && options.query.trim() !== "") {
        mustClauses.push({
          multi_match: {
            query: options.query.trim(),
            fields: [
              "title^3",
              "nombreComercial^3",
              "descripcion",
              "habilidades^2",
              "sector",
              "razonSocial",
            ],
            fuzziness: "AUTO",
          },
        });
      }

      if (options.filters) {
        Object.entries(options.filters).forEach(([key, val]) => {
          if (val !== undefined && val !== null && val !== "") {
            mustClauses.push({ term: { [key]: val } });
          }
        });
      }

      const body = {
        from: (page - 1) * limit,
        size: limit,
        query:
          mustClauses.length > 0
            ? { bool: { must: mustClauses } }
            : { match_all: {} },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = (await response.json()) as any;
        const total = json.hits?.total?.value || 0;
        const hits = (json.hits?.hits || []).map((h: any) => h._source as T);
        return {
          hits,
          total,
          page,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          source: "opensearch",
        };
      }
    } catch (error) {
      console.warn("OpenSearch query failed, falling back to DynamoDB:", error);
    }
  }

  // Fallback to DynamoDB native execution
  const allItems = await fallbackExecutor();
  let filtered = [...allItems];

  if (options.query && options.query.trim() !== "") {
    const q = options.query.toLowerCase().trim();
    filtered = filtered.filter((item: any) => {
      const textFields = [
        item.title,
        item.titulo,
        item.company,
        item.nombre,
        item.nombreComercial,
        item.razonSocial,
        item.descripcion,
        item.sector,
        item.taxId,
        ...(Array.isArray(item.habilidadesRequeridas)
          ? item.habilidadesRequeridas
          : []),
        ...(Array.isArray(item.sectores) ? item.sectores : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return textFields.includes(q);
    });
  }

  if (options.filters) {
    Object.entries(options.filters).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== "") {
        filtered = filtered.filter(
          (item: any) => String(item[key]) === String(val),
        );
      }
    });
  }

  const total = filtered.length;
  const start = (page - 1) * limit;
  const hits = filtered.slice(start, start + limit);

  return {
    hits,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    source: "dynamodb",
  };
}
