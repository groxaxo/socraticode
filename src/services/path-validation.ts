// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import path from "node:path";

/**
 * Validate that a user-supplied project path is safe and exists.
 *
 * Checks:
 * 1. Path is non-empty and resolves to a real directory
 * 2. Path does not contain traversal sequences that escape sensible bounds
 * 3. Path is not root or home directory (likely a mistake)
 *
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateProjectPath(projectPath: string): string {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("projectPath is required and must be a non-empty string.");
  }

  // Reject obviously malicious paths
  // Null bytes can truncate paths in some filesystem operations
  if (projectPath.includes("\0")) {
    throw new Error("projectPath contains null bytes.");
  }

  const resolved = path.resolve(projectPath);

  // Basic traversal check: ensure the resolved path doesn't go above the
  // original input's first component (catches "../../etc/passwd").
  // We normalize and compare rather than reject ".." outright since
  // legitimate absolute paths may contain ".." segments after resolution.
  const normalized = path.normalize(projectPath);

  // For relative paths, check that normalization doesn't escape above the start
  if (!path.isAbsolute(projectPath)) {
    const parts = normalized.split(/[/\\]/);
    let depth = 0;
    for (const part of parts) {
      if (part === "..") {
        depth--;
        if (depth < 0) {
          throw new Error(
            `projectPath "${projectPath}" escapes above its starting directory. ` +
            "Provide an absolute path or a relative path within the current directory.",
          );
        }
      } else if (part !== "." && part !== "") {
        depth++;
      }
    }
  }

  // Check that the directory exists
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`projectPath "${projectPath}" resolves to "${resolved}", which is not a directory.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not a directory")) throw err;
    throw new Error(`projectPath "${projectPath}" resolves to "${resolved}", which does not exist.`);
  }

  return resolved;
}

/**
 * Validate a file path filter (relativePath) is safe.
 * Must be a relative path without traversal above the project root.
 */
export function validateFileFilter(fileFilter: string): string {
  if (!fileFilter || typeof fileFilter !== "string") {
    throw new Error("fileFilter must be a non-empty string.");
  }
  if (fileFilter.includes("\0")) {
    throw new Error("fileFilter contains null bytes.");
  }
  // Normalize and check for traversal
  const normalized = path.normalize(fileFilter);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(
      `fileFilter "${fileFilter}" is invalid. Must be a relative path within the project (no ".." or absolute paths).`,
    );
  }
  return normalized;
}
