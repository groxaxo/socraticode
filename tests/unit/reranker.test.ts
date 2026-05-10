// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../src/types.js";

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeResult(relativePath: string, score: number): SearchResult {
  return {
    filePath: `/project/${relativePath}`,
    relativePath,
    content: `content of ${relativePath}`,
    startLine: 1,
    endLine: 10,
    language: "typescript",
    score,
  };
}

async function loadReranker(url?: string) {
  vi.resetModules();
  if (url) {
    process.env.CODEBASE_RERANKER_URL = url;
  } else {
    delete process.env.CODEBASE_RERANKER_URL;
  }
  return import("../../src/services/reranker.js");
}

afterEach(() => {
  delete process.env.CODEBASE_RERANKER_URL;
  vi.unstubAllGlobals();
});

describe("optional HTTP reranker", () => {
  it("returns original ranking when CODEBASE_RERANKER_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { isRerankerEnabled, maybeRerankSearchResults } = await loadReranker();

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2)];
    const reranked = await maybeRerankSearchResults("query", results, 1);

    expect(isRerankerEnabled()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reranked).toEqual([results[0]]);
  });

  it("orders results by reranker relevance_score", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0.98 },
        { index: 0, relevance_score: 0.72 },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { maybeRerankSearchResults } = await loadReranker("http://127.0.0.1:8099");

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2), makeResult("c.ts", 0.1)];
    const reranked = await maybeRerankSearchResults("query", results, 2);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8099/v1/rerank");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "query",
      top_n: 2,
    });
    expect(reranked.map((result) => result.relativePath)).toEqual(["c.ts", "a.ts"]);
    expect(reranked.map((result) => result.score)).toEqual([0.98, 0.72]);
  });

  it("falls back to original ranking when the reranker fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const { maybeRerankSearchResults } = await loadReranker("http://127.0.0.1:8099/v1/rerank");

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2)];
    const reranked = await maybeRerankSearchResults("query", results, 2);

    expect(reranked).toEqual(results);
  });
});
