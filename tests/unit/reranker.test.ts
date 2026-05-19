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

async function loadReranker(url?: string, maxDocumentChars?: string, env: Record<string, string> = {}) {
  vi.resetModules();
  if (url) {
    process.env.CODEBASE_RERANKER_URL = url;
  } else {
    delete process.env.CODEBASE_RERANKER_URL;
  }
  if (maxDocumentChars) {
    process.env.CODEBASE_RERANKER_MAX_DOCUMENT_CHARS = maxDocumentChars;
  } else {
    delete process.env.CODEBASE_RERANKER_MAX_DOCUMENT_CHARS;
  }
  delete process.env.CODEBASE_RERANKER_API_KEY;
  delete process.env.CODEBASE_RERANKER_FORMAT;
  delete process.env.DEEPINFRA_API_KEY;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return import("../../src/services/reranker.js");
}

afterEach(() => {
  delete process.env.CODEBASE_RERANKER_URL;
  delete process.env.CODEBASE_RERANKER_MAX_DOCUMENT_CHARS;
  delete process.env.CODEBASE_RERANKER_API_KEY;
  delete process.env.CODEBASE_RERANKER_FORMAT;
  delete process.env.DEEPINFRA_API_KEY;
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

  it("falls back to original ranking when reranker scores are not discriminative", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0 },
        { index: 0, relevance_score: 0 },
        { index: 1, relevance_score: 0 },
      ],
    }), { status: 200 })));
    const { maybeRerankSearchResults } = await loadReranker("http://127.0.0.1:8099/v1/rerank");

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2), makeResult("c.ts", 0.1)];
    const reranked = await maybeRerankSearchResults("query", results, 2);

    expect(reranked).toEqual([results[0], results[1]]);
  });

  it("falls back to original ranking when reranker scores are effectively zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 2e-37 },
        { index: 0, relevance_score: 1e-37 },
        { index: 1, relevance_score: 8e-38 },
      ],
    }), { status: 200 })));
    const { maybeRerankSearchResults } = await loadReranker("http://127.0.0.1:8099/v1/rerank");

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2), makeResult("c.ts", 0.1)];
    const reranked = await maybeRerankSearchResults("query", results, 2);

    expect(reranked).toEqual([results[0], results[1]]);
  });

  it("truncates long reranker documents", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { maybeRerankSearchResults } = await loadReranker("http://127.0.0.1:8099/v1/rerank", "200");

    const result = makeResult("long.ts", 0.3);
    result.content = `${"a".repeat(250)}TAIL`;

    await maybeRerankSearchResults("query", [result, makeResult("b.ts", 0.2)], 1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.documents[0]).toContain("a".repeat(200));
    expect(body.documents[0]).toContain("[truncated for reranker]");
    expect(body.documents[0]).not.toContain("TAIL");
  });

  it("supports DeepInfra inference reranker endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      scores: [0.2, 0.9, 0.4],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-4B";
    const { maybeRerankSearchResults } = await loadReranker(endpoint, undefined, {
      CODEBASE_RERANKER_API_KEY: "test-key",
    });

    const results = [makeResult("a.ts", 0.3), makeResult("b.ts", 0.2), makeResult("c.ts", 0.1)];
    const reranked = await maybeRerankSearchResults("query", results, 2);

    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      authorization: "Bearer test-key",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      queries: ["query"],
      documents: expect.any(Array),
    });
    expect(reranked.map((result) => result.relativePath)).toEqual(["b.ts", "c.ts"]);
    expect(reranked.map((result) => result.score)).toEqual([0.9, 0.4]);
  });
});
