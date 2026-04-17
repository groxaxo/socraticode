// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import path from "node:path";
import { mergeExtraExtensions } from "../constants.js";
import { awaitGraphBuild, findCircularDependencies, generateMermaidDiagram, getFileDependencies, getGraphBuildProgress, getGraphStats, getGraphStatus, getLastGraphBuildCompleted, getOrBuildGraph, isGraphBuildInProgress, rebuildGraph, removeGraph } from "../services/code-graph.js";
import { logger } from "../services/logger.js";
import { validateProjectPath } from "../services/path-validation.js";
import { ensureWatcherStarted } from "../services/watcher.js";

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const rawProjectPath = (args.projectPath as string) || process.cwd();
  let projectPath: string;
  try {
    projectPath = validateProjectPath(rawProjectPath);
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid project path.";
  }

  // Auto-start watcher on any graph interaction (fire-and-forget)
  ensureWatcherStarted(projectPath);

  switch (name) {
    case "codebase_graph_build": {
      const resolved = projectPath;

      // Concurrency guard: if already building, show progress
      if (isGraphBuildInProgress(resolved)) {
        const progress = getGraphBuildProgress(resolved);
        const lines = [
          `⚠ Graph build already in progress for: ${resolved}`,
        ];
        if (progress) {
          const elapsed = ((Date.now() - progress.startedAt) / 1000).toFixed(0);
          const pct = progress.filesTotal > 0
            ? ` (${Math.round((progress.filesProcessed / progress.filesTotal) * 100)}%)`
            : "";
          lines.push(`Phase: ${progress.phase}`);
          lines.push(`Progress: ${progress.filesProcessed}/${progress.filesTotal} files${pct}`);
          lines.push(`Elapsed: ${elapsed}s`);
        }
        lines.push("", "Call codebase_graph_status to check progress.");
        return lines.join("\n");
      }

      // Fire-and-forget: start graph build in the background
      const extraExts = mergeExtraExtensions(args.extraExtensions as string | undefined);
      rebuildGraph(resolved, extraExts.size > 0 ? extraExts : undefined)
        .then((graph) => {
          logger.info("Background graph build completed", {
            projectPath: resolved,
            nodes: graph.nodes.length,
            edges: graph.edges.length,
          });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Background graph build failed", { projectPath: resolved, error: message });
        });

      return [
        `Graph build started in the background for: ${resolved}`,
        "",
        "IMPORTANT: The graph is now building asynchronously.",
        "Call codebase_graph_status to check progress. Keep calling it periodically until the build completes.",
        "Once complete, you can use codebase_graph_query, codebase_graph_stats, etc. to explore the graph.",
      ].join("\n");
    }

    case "codebase_graph_query": {
      const filePath = args.filePath as string;
      if (!filePath || typeof filePath !== "string" || filePath.includes("\0")) {
        return "Error: filePath must be a non-empty string without null bytes.";
      }
      // Reject absolute paths or traversal
      const normalizedFilePath = path.normalize(filePath);
      if (path.isAbsolute(normalizedFilePath) || normalizedFilePath.startsWith("..")) {
        return "Error: filePath must be a relative path within the project (no absolute paths or '..' traversal).";
      }
      const graph = await getOrBuildGraph(projectPath);
      const deps = getFileDependencies(graph, filePath);

      const lines = [`Dependencies for: ${filePath}\n`];

      if (deps.imports.length === 0 && deps.importedBy.length === 0) {
        lines.push("No dependency information found for this file.");
        lines.push("Make sure codebase_graph_build has been run and the file path is relative.");
      } else {
        if (deps.imports.length > 0) {
          lines.push(`Imports (${deps.imports.length}):`);
          for (const imp of deps.imports) {
            lines.push(`  → ${imp}`);
          }
        }

        if (deps.importedBy.length > 0) {
          lines.push(`\nImported by (${deps.importedBy.length}):`);
          for (const dep of deps.importedBy) {
            lines.push(`  ← ${dep}`);
          }
        }
      }

      return lines.join("\n");
    }

    case "codebase_graph_stats": {
      const graph = await getOrBuildGraph(projectPath);

      if (graph.nodes.length === 0) {
        return "No graph data available. Run codebase_graph_build first.";
      }

      const stats = getGraphStats(graph);

      const lines = [
        `Code Graph Statistics for: ${projectPath}\n`,
        `Total files: ${stats.totalFiles}`,
        `Total dependency edges: ${stats.totalEdges}`,
        `Average dependencies per file: ${stats.avgDependencies.toFixed(1)}`,
        `Circular dependency chains: ${stats.circularDeps}`,
      ];

      if (Object.keys(stats.languageBreakdown).length > 0) {
        lines.push("", "Languages:");
        for (const [lang, count] of Object.entries(stats.languageBreakdown).sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${lang}: ${count} files`);
        }
      }

      lines.push("", `Most connected files (top 10):`);
      for (const f of stats.mostConnected) {
        lines.push(`  ${f.file}: ${f.connections} connections`);
      }

      if (stats.orphans.length > 0) {
        lines.push("");
        lines.push(`Orphan files (no dependencies, showing first 20):`);
        for (const f of stats.orphans.slice(0, 20)) {
          lines.push(`  ${f}`);
        }
        if (stats.orphans.length > 20) {
          lines.push(`  ... and ${stats.orphans.length - 20} more`);
        }
      }

      return lines.join("\n");
    }

    case "codebase_graph_circular": {
      const graph = await getOrBuildGraph(projectPath);
      const cycles = findCircularDependencies(graph);

      if (cycles.length === 0) {
        return "No circular dependencies found.";
      }

      const lines = [`Found ${cycles.length} circular dependency chain(s):\n`];
      for (let i = 0; i < Math.min(cycles.length, 20); i++) {
        lines.push(`Cycle ${i + 1}: ${cycles[i].join(" → ")}`);
      }
      if (cycles.length > 20) {
        lines.push(`\n... and ${cycles.length - 20} more cycles`);
      }

      return lines.join("\n");
    }

    case "codebase_graph_visualize": {
      const graph = await getOrBuildGraph(projectPath);

      if (graph.nodes.length === 0) {
        return "No graph data available. Run codebase_graph_build first.";
      }

      const mermaid = generateMermaidDiagram(graph);
      return [
        `Dependency graph for: ${projectPath}`,
        `(${graph.nodes.length} files, ${graph.edges.length} edges)`,
        "",
        "```mermaid",
        mermaid,
        "```",
      ].join("\n");
    }

    case "codebase_graph_remove": {
      // Wait for any in-flight graph build to finish before removing
      if (isGraphBuildInProgress(projectPath)) {
        logger.info("Waiting for in-flight graph build to finish before removing graph", { projectPath });
        await awaitGraphBuild(projectPath);
      }
      await removeGraph(projectPath);
      return `Removed code graph for: ${projectPath}`;
    }

    case "codebase_graph_status": {
      const resolved = projectPath;

      // Show in-flight build progress if building
      if (isGraphBuildInProgress(resolved)) {
        const progress = getGraphBuildProgress(resolved);
        if (!progress) return "No progress data available.";
        const elapsed = ((Date.now() - progress.startedAt) / 1000).toFixed(0);
        const pct = progress.filesTotal > 0
          ? Math.round((progress.filesProcessed / progress.filesTotal) * 100)
          : 0;

        return [
          `Code Graph Status for: ${resolved}`,
          "",
          `Status: BUILDING`,
          `Phase: ${progress.phase}`,
          `Progress: ${progress.filesProcessed}/${progress.filesTotal} files (${pct}%)`,
          `Elapsed: ${elapsed}s`,
          "",
          "The graph is being built in the background.",
          "Call codebase_graph_status again to check progress.",
        ].join("\n");
      }

      // Show last completed build info if available
      const lastBuild = getLastGraphBuildCompleted(resolved);

      const graphInfo = await getGraphStatus(resolved);
      if (!graphInfo) {
        const lines = [`No code graph found for: ${resolved}`];
        if (lastBuild?.error) {
          lines.push(`Last build failed: ${lastBuild.error}`);
        }
        lines.push("Run codebase_graph_build or codebase_index to create one.");
        return lines.join("\n");
      }

      const ago = ((Date.now() - new Date(graphInfo.lastBuiltAt).getTime()) / 1000).toFixed(0);
      const lines = [
        `Code Graph Status for: ${resolved}`,
        "",
        `Status: READY`,
        `Files (nodes): ${graphInfo.nodeCount}`,
        `Dependencies (edges): ${graphInfo.edgeCount}`,
        `Last built: ${graphInfo.lastBuiltAt} (${ago}s ago)`,
        `In-memory cache: ${graphInfo.cached ? "yes" : "no (will load from storage on next query)"}`,
      ];

      if (lastBuild) {
        lines.push(`Last build duration: ${(lastBuild.durationMs / 1000).toFixed(1)}s`);
      }

      return lines.join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
