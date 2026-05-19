// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import {
  CODEBASE_RERANKER_API_KEY,
  CODEBASE_RERANKER_FORMAT,
  CODEBASE_RERANKER_MAX_DOCUMENT_CHARS,
  CODEBASE_RERANKER_MIN_SCORE_DELTA,
  CODEBASE_RERANKER_MIN_TOP_SCORE,
  CODEBASE_RERANKER_TIMEOUT_MS,
  CODEBASE_RERANKER_URL,
} from "../constants.js";
import type { SearchResult } from "../types.js";
import { logger } from "./logger.js";

type RerankHit = {
  index?: unknown;
  relevance_score?: unknown;
  score?: unknown;
};

export function isRerankerEnabled(): boolean {
  return Boolean(CODEBASE_RERANKER_URL);
}

function rerankerEndpoint(): string | undefined {
  if (!CODEBASE_RERANKER_URL) return undefined;
  const trimmed = CODEBASE_RERANKER_URL.replace(/\/+$/, "");
  if (CODEBASE_RERANKER_FORMAT === "deepinfra" || trimmed.includes("/v1/inference/")) return trimmed;
  return trimmed.endsWith("/rerank") ? trimmed : `${trimmed}/v1/rerank`;
}

function documentText(result: SearchResult): string {
  const content = result.content.length > CODEBASE_RERANKER_MAX_DOCUMENT_CHARS
    ? `${result.content.slice(0, CODEBASE_RERANKER_MAX_DOCUMENT_CHARS)}\n\n[truncated for reranker]`
    : result.content;

  return [
    `Path: ${result.relativePath}`,
    `Language: ${result.language}`,
    `Lines: ${result.startLine}-${result.endLine}`,
    "",
    content,
  ].join("\n");
}

function requestFormat(endpoint: string): "openai" | "deepinfra" {
  if (CODEBASE_RERANKER_FORMAT === "deepinfra") return "deepinfra";
  if (CODEBASE_RERANKER_FORMAT === "openai") return "openai";
  return endpoint.includes("api.deepinfra.com/v1/inference/") ? "deepinfra" : "openai";
}

function rerankerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (CODEBASE_RERANKER_API_KEY) {
    headers.authorization = `Bearer ${CODEBASE_RERANKER_API_KEY}`;
  }
  return headers;
}

function rerankerBody(endpoint: string, query: string, documents: string[], limit: number): unknown {
  if (requestFormat(endpoint) === "deepinfra") {
    return { queries: [query], documents };
  }
  return { query, documents, top_n: limit };
}

function extractHits(body: unknown): RerankHit[] {
  if (Array.isArray(body)) return body as RerankHit[];
  if (!body || typeof body !== "object") return [];
  const data = body as { results?: unknown; data?: unknown; scores?: unknown };
  if (Array.isArray(data.scores)) {
    return data.scores.map((score, index) => ({ index, score }));
  }
  if (Array.isArray(data.results)) return data.results as RerankHit[];
  if (Array.isArray(data.data)) return data.data as RerankHit[];
  return [];
}

function scoreFromHit(hit: RerankHit): number | undefined {
  const score = typeof hit.relevance_score === "number" ? hit.relevance_score : hit.score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

export async function maybeRerankSearchResults(
  query: string,
  results: SearchResult[],
  limit: number,
): Promise<SearchResult[]> {
  const endpoint = rerankerEndpoint();
  if (!endpoint || results.length <= 1) return results.slice(0, limit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEBASE_RERANKER_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: rerankerHeaders(),
      body: JSON.stringify(rerankerBody(endpoint, query, results.map(documentText), limit)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const scored = extractHits(await response.json())
      .map((hit) => ({
        index: typeof hit.index === "number" ? hit.index : -1,
        score: scoreFromHit(hit),
      }))
      .filter((hit): hit is { index: number; score: number } => (
        hit.index >= 0 && hit.index < results.length && hit.score !== undefined
      ));

    if (scored.length === 0) return results.slice(0, limit);
    const scores = scored.map((hit) => hit.score);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    if (maxScore < CODEBASE_RERANKER_MIN_TOP_SCORE || maxScore - minScore < CODEBASE_RERANKER_MIN_SCORE_DELTA) {
      return results.slice(0, limit);
    }

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<number>();
    const reranked = scored.map(({ index, score }) => {
      seen.add(index);
      return { ...results[index], score };
    });
    const fallbackTail = results.filter((_result, index) => !seen.has(index));
    return [...reranked, ...fallbackTail].slice(0, limit);
  } catch (err) {
    logger.warn("Optional reranker failed; falling back to Qdrant hybrid ranking", {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    return results.slice(0, limit);
  } finally {
    clearTimeout(timeout);
  }
}
