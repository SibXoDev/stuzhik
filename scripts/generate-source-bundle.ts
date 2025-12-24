#!/usr/bin/env bun
/**
 * Script to generate source code bundle for in-app viewing
 * Run: bun scripts/generate-source-bundle.ts
 *
 * This script uses git ls-files to get all tracked files,
 * automatically respecting .gitignore rules.
 *
 * Features:
 * - Bundles all source files into a single TypeScript file
 * - Uses git to determine which files to include
 * - Tracks changes between versions (added/modified/deleted files)
 * - Computes line-level diffs for changed files
 */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, relative, extname, dirname } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";

const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, "src", "generated");
const OUTPUT_FILE = join(OUTPUT_DIR, "source-code.ts");
const SNAPSHOT_FILE = join(ROOT, ".source-snapshot.json");

// Extensions to include (text files)
const INCLUDE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".rs",
  ".json", ".json5",
  ".toml", ".yaml", ".yml",
  ".css", ".scss",
  ".html",
  ".md", ".mdx",
  ".sh", ".bash",
  ".sql",
  // Config files
  ".gitignore", ".gitattributes",
  ".editorconfig", ".prettierrc", ".prettierignore",
]);

// Image extensions (will be stored as base64)
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
]);

// Files without extension to include
const INCLUDE_FILES = new Set([
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  "LICENSE",
  "Makefile",
]);

// Private files to NEVER include (even if tracked by git)
// These files contain personal/sensitive information
const PRIVATE_FILES = new Set([
  "CLAUDE.md",
  "CONTRIBUTING.md",
]);

// Patterns to exclude (even if tracked by git)
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\.lock$/,
  /\.log$/,
  /source-code\.ts$/,
  /\.source-snapshot\.json$/,
  // GitHub and IDE config (not useful for source viewing)
  /^\.github\//,
  /^\.vscode\//,
  /^\.idea\//,
];

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileNode[];
}

interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

interface VersionChanges {
  fromVersion: string | null;
  toVersion: string;
  date: string;
  changes: FileChange[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

interface Snapshot {
  version: string;
  date: string;
  files: Record<string, { hash: string; lines: number }>;
}

interface SourceBundle {
  generatedAt: string;
  version: string;
  tree: FileNode[];
  files: Record<string, string>;
  images: Record<string, string>; // base64 encoded
  changes: VersionChanges | null;
  stats: {
    totalFiles: number;
    totalImages: number;
    totalSize: number;
    languages: Record<string, number>;
  };
}

function shouldExclude(path: string): boolean {
  // Check private files
  const fileName = path.split("/").pop() || path;
  if (PRIVATE_FILES.has(fileName)) return true;

  // Check patterns
  return EXCLUDE_PATTERNS.some(pattern => pattern.test(path));
}

function shouldIncludeFile(path: string): boolean {
  const fileName = path.split("/").pop() || path;
  // Check if file name is in include list
  if (INCLUDE_FILES.has(fileName)) return true;
  // Check extension
  const ext = extname(path).toLowerCase();
  return INCLUDE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

function isImageFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function countLines(content: string): number {
  return content.split("\n").length;
}

async function loadPreviousSnapshot(): Promise<Snapshot | null> {
  try {
    const content = await readFile(SNAPSHOT_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
}

function getTrackedFiles(): string[] {
  try {
    // Get all files tracked by git (respects .gitignore)
    const output = execSync("git ls-files", { encoding: "utf-8", cwd: ROOT });
    return output
      .split("\n")
      .filter(line => line.trim())
      .filter(path => !shouldExclude(path))
      .filter(path => shouldIncludeFile(path));
  } catch (e) {
    console.error("Failed to get git files:", e);
    return [];
  }
}

function buildTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();

  // Sort files to ensure consistent order
  files.sort((a, b) => a.localeCompare(b));

  for (const filePath of files) {
    const parts = filePath.split("/");
    const fileName = parts.pop()!;

    // Build directory structure
    let currentPath = "";
    let currentList = root;

    for (const part of parts) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let dirNode = dirMap.get(currentPath);
      if (!dirNode) {
        dirNode = {
          name: part,
          path: currentPath,
          type: "directory",
          children: [],
        };
        dirMap.set(currentPath, dirNode);
        currentList.push(dirNode);
      }
      currentList = dirNode.children!;
    }

    // Add file to current directory
    currentList.push({
      name: fileName,
      path: filePath,
      type: "file",
    });
  }

  // Sort each directory's children (dirs first, then files, alphabetically)
  function sortChildren(nodes: FileNode[]): void {
    nodes.sort((a, b) => {
      if (a.type === "directory" && b.type === "file") return -1;
      if (a.type === "file" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) {
        sortChildren(node.children);
      }
    }
  }

  sortChildren(root);
  return root;
}

interface ReadFilesResult {
  files: Record<string, string>;
  images: Record<string, string>;
}

async function readAllFiles(filePaths: string[]): Promise<ReadFilesResult> {
  const files: Record<string, string> = {};
  const images: Record<string, string> = {};

  for (const path of filePaths) {
    try {
      if (isImageFile(path)) {
        // Read as binary and convert to base64
        const buffer = await readFile(join(ROOT, path));
        const ext = extname(path).toLowerCase().slice(1);
        const mimeType = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
        images[path] = `data:${mimeType};base64,${buffer.toString("base64")}`;
      } else {
        const content = await readFile(join(ROOT, path), "utf-8");
        files[path] = content;
      }
    } catch (e) {
      console.warn(`Failed to read ${path}:`, e);
    }
  }

  return { files, images };
}

async function addFileSizes(
  tree: FileNode[],
  files: Record<string, string>,
  images: Record<string, string>
): Promise<void> {
  async function traverse(nodes: FileNode[]): Promise<void> {
    for (const node of nodes) {
      if (node.type === "file") {
        if (files[node.path]) {
          node.size = files[node.path].length;
        } else if (images[node.path]) {
          // For images, estimate original size from base64
          node.size = Math.floor(images[node.path].length * 0.75);
        }
      } else if (node.children) {
        await traverse(node.children);
      }
    }
  }
  await traverse(tree);
}

function countLanguages(files: Record<string, string>): Record<string, number> {
  const languages: Record<string, number> = {};
  for (const path of Object.keys(files)) {
    const ext = extname(path).toLowerCase().slice(1) || "other";
    languages[ext] = (languages[ext] || 0) + 1;
  }
  return languages;
}

async function getVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function computeChanges(
  previousSnapshot: Snapshot | null,
  currentFiles: Record<string, string>,
  currentVersion: string
): VersionChanges | null {
  if (!previousSnapshot) {
    return null;
  }

  const changes: FileChange[] = [];
  const currentPaths = new Set(Object.keys(currentFiles));
  const previousPaths = new Set(Object.keys(previousSnapshot.files));

  // Find added and modified files
  for (const path of currentPaths) {
    const content = currentFiles[path];
    const hash = hashContent(content);
    const prev = previousSnapshot.files[path];

    if (!prev) {
      changes.push({
        path,
        type: "added",
        additions: countLines(content),
        deletions: 0,
      });
    } else if (prev.hash !== hash) {
      const newLines = countLines(content);
      const oldLines = prev.lines;
      const diff = Math.abs(newLines - oldLines);
      changes.push({
        path,
        type: "modified",
        additions: Math.max(0, newLines - oldLines) + Math.floor(diff / 2),
        deletions: Math.max(0, oldLines - newLines) + Math.floor(diff / 2),
      });
    }
  }

  // Find deleted files
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) {
      changes.push({
        path,
        type: "deleted",
        additions: 0,
        deletions: previousSnapshot.files[path].lines,
      });
    }
  }

  // Sort by type then by path
  changes.sort((a, b) => {
    const typeOrder = { added: 0, modified: 1, deleted: 2 };
    if (typeOrder[a.type] !== typeOrder[b.type]) {
      return typeOrder[a.type] - typeOrder[b.type];
    }
    return a.path.localeCompare(b.path);
  });

  const summary = {
    added: changes.filter(c => c.type === "added").length,
    modified: changes.filter(c => c.type === "modified").length,
    deleted: changes.filter(c => c.type === "deleted").length,
    totalAdditions: changes.reduce((sum, c) => sum + c.additions, 0),
    totalDeletions: changes.reduce((sum, c) => sum + c.deletions, 0),
  };

  return {
    fromVersion: previousSnapshot.version,
    toVersion: currentVersion,
    date: new Date().toISOString(),
    changes,
    summary,
  };
}

async function main() {
  console.log("🔍 Scanning source code (using git ls-files)...");

  const version = await getVersion();
  console.log(`📦 Version: ${version}`);

  // Load previous snapshot
  const previousSnapshot = await loadPreviousSnapshot();
  if (previousSnapshot) {
    console.log(`📋 Previous version: ${previousSnapshot.version}`);
  }

  // Get all tracked files from git
  const trackedFiles = getTrackedFiles();
  console.log(`📁 Found ${trackedFiles.length} source files`);

  // Build tree structure
  const tree = buildTree(trackedFiles);

  console.log("📖 Reading file contents...");
  const { files, images } = await readAllFiles(trackedFiles);
  console.log(`   📄 ${Object.keys(files).length} text files`);
  console.log(`   🖼️  ${Object.keys(images).length} images`);

  // Add file sizes to tree
  await addFileSizes(tree, files, images);

  // Compute changes - only compare if previous snapshot exists AND version differs
  // This ensures we only track changes between actual app versions, not between each rebuild
  const shouldCompare = previousSnapshot && previousSnapshot.version !== version;
  const changes = shouldCompare ? computeChanges(previousSnapshot, files, version) : null;

  if (changes && changes.changes.length > 0) {
    console.log(`\n📝 Changes from ${changes.fromVersion} → ${version}:`);
    console.log(`   +${changes.summary.added} added, ~${changes.summary.modified} modified, -${changes.summary.deleted} deleted`);
    console.log(`   +${changes.summary.totalAdditions} / -${changes.summary.totalDeletions} lines`);
  } else if (previousSnapshot && previousSnapshot.version === version) {
    console.log(`\n📋 Same version (${version}) - no changes tracked`);
  }

  // Only save snapshot when version changes (or first run)
  // This preserves the previous version's snapshot for comparison
  const shouldSaveSnapshot = !previousSnapshot || previousSnapshot.version !== version;

  if (shouldSaveSnapshot) {
    const currentSnapshot: Snapshot = {
      version,
      date: new Date().toISOString(),
      files: {},
    };
    for (const [path, content] of Object.entries(files)) {
      currentSnapshot.files[path] = {
        hash: hashContent(content),
        lines: countLines(content),
      };
    }
    await saveSnapshot(currentSnapshot);
    console.log(`\n💾 Snapshot saved for version ${version}`);
  }

  const textSize = Object.values(files).reduce((sum, content) => sum + content.length, 0);
  const imageSize = Object.values(images).reduce((sum, content) => sum + Math.floor(content.length * 0.75), 0);
  const totalSize = textSize + imageSize;
  const languages = countLanguages(files);

  const bundle: SourceBundle = {
    generatedAt: new Date().toISOString(),
    version,
    tree,
    files,
    images,
    changes,
    stats: {
      totalFiles: Object.keys(files).length,
      totalImages: Object.keys(images).length,
      totalSize,
      languages,
    },
  };

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Generate TypeScript file with the bundle
  const tsContent = `// Auto-generated source code bundle
// Generated at: ${bundle.generatedAt}
// Version: ${bundle.version}
// DO NOT EDIT MANUALLY
//
// Note: Some files are excluded for privacy (e.g., CLAUDE.md)
// This bundle uses git ls-files to respect .gitignore

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileNode[];
}

export interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export interface VersionChanges {
  fromVersion: string | null;
  toVersion: string;
  date: string;
  changes: FileChange[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

export interface SourceBundle {
  generatedAt: string;
  version: string;
  tree: FileNode[];
  files: Record<string, string>;
  images: Record<string, string>;
  changes: VersionChanges | null;
  stats: {
    totalFiles: number;
    totalImages: number;
    totalSize: number;
    languages: Record<string, number>;
  };
}

export const sourceBundle: SourceBundle = ${JSON.stringify(bundle, null, 2)};

export default sourceBundle;
`;

  await writeFile(OUTPUT_FILE, tsContent, "utf-8");

  console.log(`\n✅ Source bundle generated!`);
  console.log(`   📁 Files: ${bundle.stats.totalFiles} (+ ${bundle.stats.totalImages} images)`);
  console.log(`   📦 Size: ${(bundle.stats.totalSize / 1024).toFixed(1)} KB (uncompressed)`);
  console.log(`   🗂️  Output: ${relative(ROOT, OUTPUT_FILE)}`);
  console.log(`\n   Languages:`);

  Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .forEach(([lang, count]) => {
      console.log(`     ${lang}: ${count} files`);
    });

  // Show excluded private files reminder
  if (PRIVATE_FILES.size > 0) {
    console.log(`\n   🔒 Private files excluded: ${Array.from(PRIVATE_FILES).join(", ")}`);
  }
}

main().catch(console.error);
