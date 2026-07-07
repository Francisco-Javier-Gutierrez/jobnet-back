import { Client } from "@opensearch-project/opensearch";

const endpoint = process.env.OPENSEARCH_ENDPOINT || "http://localhost:9200";

export const getOpenSearchClient = () => {
  if (process.env.IS_OFFLINE || endpoint.includes("localhost")) {
    return new Client({
      node: endpoint,
    });
  }
  return new Client({
    node: endpoint,
    auth: {
      username: process.env.OPENSEARCH_USERNAME || "",
      password: process.env.OPENSEARCH_PASSWORD || "",
    },
  });
};
