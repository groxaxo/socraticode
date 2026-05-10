// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { CODEBASE_RERANKER_TIMEOUT_MS, CODEBASE_RERANKER_URL } from "../constants.js";
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
  return trimmed.endsWith("/rerank") ? trimmed : `${trimmed}/v1/rerank`;
}

function documentText(result: SearchResult): string {
  return [
    `Path: ${result.relativePath}`,
    `Language: ${result.language}`,
    `Lines: ${result.startLine}-${result.endLine}`,
    "",
    result.content,
  ].join("\n");
}

function extractHits(body: unknown): RerankHit[] {
  if (Array.isArray(body)) return body as RerankHit[];
  if (!body || typeof body !== "object") return [];
  const data = body as { results?: unknown; data?: unknown };
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        documents: results.map(documentText),
        top_n: limit,
      }),
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
      ))
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return results.slice(0, limit);

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
