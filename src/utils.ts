// ---------------------------------------------------------------------------
// Shared utilities for Claude Code session history
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { Session, ProjectDir } from "./types.js";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = path.join(CLAUDE_DIR, "history.jsonl");
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Configuration (key-config.json)
// ---------------------------------------------------------------------------

export function getConfigFile(): string {
    return path.join(os.homedir(), ".claude", "key-config.json");
}

export function ensureConfig(): void {
    const dir = path.join(os.homedir(), ".claude");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(getConfigFile())) {
        fs.writeFileSync(getConfigFile(), "{}");
    }
}

export function configGet(configPath: string, defaultValue = ""): string {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj = d;
    for (const k of keys) {
        if (obj == null || typeof obj !== "object") return defaultValue;
        obj = obj[k];
    }
    return obj != null ? String(obj) : defaultValue;
}

/**
 * Read a config value without string coercion. Returns the raw value (may be an
 * object, array, number, boolean, or string) or undefined if the path is missing.
 *
 * Use this for config keys that store structured data (objects/arrays).
 * For simple string config use `configGet` which returns a string.
 */
export function configGetObject(configPath: string): unknown {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj: unknown = d;
    for (const k of keys) {
        if (obj == null || typeof obj !== "object") return undefined;
        obj = (obj as Record<string, unknown>)[k];
    }
    return obj ?? undefined;
}

/**
 * Write a structured (non-string) config value. Use this for config keys that store
 * objects, arrays, numbers, or booleans. For plain strings, `configSet` also works.
 */
export function configSetObject(configPath: string, value: unknown): void {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj = d;
    for (const k of keys.slice(0, -1)) {
        if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
        obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    fs.writeFileSync(getConfigFile(), JSON.stringify(d, null, 2));
}

export function configSet(configPath: string, value: string): void {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj = d;
    for (const k of keys.slice(0, -1)) {
        if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
        obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    fs.writeFileSync(getConfigFile(), JSON.stringify(d, null, 2));
}

// ---------------------------------------------------------------------------
// Path encoding/decoding
// ---------------------------------------------------------------------------

/** Convert an absolute path to a Claude project directory name. */
export function pathToDirname(p: string): string {
    return p.replace(/\//g, "-").replace(/\./g, "-");
}

/** Convert a Claude project directory name back to an absolute path.
 *
 * Since pathToDirname replaces both / and . with -, the reverse is ambiguous
 * when path components contain dashes (e.g. 'claude-relay'). We resolve this
 * by listing actual directory contents at each level.
 */
export function dirnameToPath(dirname: string): string {
    if (!dirname.startsWith("-")) {
        return dirname.replace(/-/g, "/");
    }

    const raw = dirname.slice(1).split("-");
    if (raw.length === 0) return "/";

    // Handle -- sequences: Claude Code replaces both / and . with -,
    // so -- typically means a dot-prefixed component (e.g. .claude -> --claude).
    const parts: string[] = [];
    let i = 0;
    while (i < raw.length) {
        if (raw[i] === "" && i + 1 < raw.length) {
            parts.push("." + raw[i + 1]);
            i += 2;
        } else {
            parts.push(raw[i]);
            i += 1;
        }
    }

    function resolve(parts: string[], current: string): string {
        if (parts.length === 0) return current;

        if (fs.existsSync(current) && fs.statSync(current).isDirectory()) {
            let entries: Set<string>;
            try {
                entries = new Set(fs.readdirSync(current));
            } catch {
                entries = new Set();
            }
            for (let j = 1; j <= parts.length; j++) {
                const segment = parts.slice(0, j).join("-");
                if (!entries.has(segment)) continue;
                const candidate = current + "/" + segment;
                const remaining = parts.slice(j);
                if (remaining.length === 0) return candidate;
                if (fs.statSync(candidate).isDirectory()) {
                    const result = resolve(remaining, candidate);
                    if (fs.existsSync(result)) return result;
                }
            }
        }

        return resolve(parts.slice(1), current + "/" + parts[0]);
    }

    return resolve(parts, "");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Throw if the Claude projects directory doesn't exist. */
export function requireProjectsDir(): void {
    if (!fs.existsSync(PROJECTS_DIR) || !fs.statSync(PROJECTS_DIR).isDirectory()) {
        throw new Error(`No Claude projects directory found at ${PROJECTS_DIR}`);
    }
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/** Get Anthropic API key from macOS Keychain, falling back to env var. */
export function getApiKey(): string | null {
    if (process.platform === "darwin") {
        try {
            const result = execFileSync("security", ["find-generic-password", "-s", "Claude Code", "-w"], {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            if (result) return result;
        } catch {
            // Keychain lookup failed, try env var
        }
    }
    return process.env.ANTHROPIC_API_KEY || null;
}

/** Get API key or throw. */
export function requireApiKey(): string {
    const key = getApiKey();
    if (!key) {
        throw new Error("No API key found. Set ANTHROPIC_API_KEY or store a key via claude-set-key");
    }
    return key;
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

/**
 * Anthropic API usage block, mirroring the Messages API's `usage` field.
 * Cache fields are present whenever ephemeral cache_control is in play.
 */
export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/** Rich result from a Claude API call, including the usage block and the model that served the request. */
export interface CallClaudeResult {
    /** Concatenated text from the response's content blocks (trimmed). */
    text: string;
    /** Usage block from the response, or undefined if the API did not return one. */
    usage?: AnthropicUsage;
    /** Model that served the request (echoed by the API; falls back to the requested model). */
    model: string;
}

/**
 * Call the Claude API and return the text response plus usage metadata.
 *
 * Producers that want their out-of-process LLM costs to surface in the
 * parent Claude Code session's spend accumulator can pass the returned
 * `usage` and `model` through to the MCP `_meta` field on tool results
 * (or to the hook output JSON envelope). Any consumer that recognizes
 * those optional fields can route them into the parent's accumulator;
 * consumers that don't recognize them treat them as unknown keys.
 */
export async function callClaudeWithMeta(
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens = 1024
): Promise<CallClaudeResult> {
    const body = JSON.stringify({ model, max_tokens: maxTokens, messages });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body,
    });

    if (!resp.ok) {
        const errorBody = await resp.text();
        throw new Error(`Claude API error ${resp.status}: ${errorBody.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: AnthropicUsage;
        model?: string;
    };
    for (const block of data.content ?? []) {
        if (block.type === "text" && block.text) {
            return { text: block.text.trim(), usage: data.usage, model: data.model ?? model };
        }
    }
    throw new Error("No text content in Claude API response");
}

/**
 * Call the Claude API and return only the text response.
 *
 * Thin convenience wrapper around `callClaudeWithMeta` for callers that
 * don't need usage data. New code that wants to forward usage to the
 * parent's spend accumulator should call `callClaudeWithMeta` directly.
 */
export async function callClaude(
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens = 1024
): Promise<string> {
    const result = await callClaudeWithMeta(apiKey, model, messages, maxTokens);
    return result.text;
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

/** Recursively extract all string values from a JSON object. */
export function extractStrings(obj: unknown, depth = 0): string[] {
    if (depth > 10) return [];
    if (typeof obj === "string") return [obj];
    if (Array.isArray(obj)) {
        return obj.flatMap((item) => extractStrings(item, depth + 1));
    }
    if (obj && typeof obj === "object") {
        return Object.values(obj).flatMap((v) => extractStrings(v, depth + 1));
    }
    return [];
}

/** Parse a session .jsonl file and return its metadata. */
export function parseSession(filepath: string): Session {
    let msgCount = 0;
    let firstPrompt = "";
    let summary = "";
    let customTitle = "";
    let aiTitle = "";
    let slug = "";
    let agentName = "";
    let created = "";
    let modified = "";

    const content = fs.readFileSync(filepath, "utf-8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(trimmed);
        } catch {
            continue;
        }

        const t = entry.type as string | undefined;

        if (!slug && typeof entry.slug === "string") {
            slug = entry.slug;
        }

        if (t === "agent-name") {
            agentName = (entry.agentName as string) || "";
        } else if (t === "custom-title") {
            customTitle = (entry.customTitle as string) || "";
        } else if (t === "ai-title") {
            aiTitle = (entry.aiTitle as string) || "";
        } else if (t === "summary" && !summary) {
            const s = (entry.summary as string) || "";
            if (s && !s.startsWith("I don") && !s.startsWith("Unable to")) {
                summary = s;
            }
        }

        if (t === "user" || t === "assistant") {
            msgCount++;
            const ts = (entry.timestamp as string) || "";
            if (ts) {
                if (!created) created = ts;
                modified = ts;
            }
            if (t === "user" && !firstPrompt) {
                const msg = entry.message as { content?: unknown } | undefined;
                const c = msg?.content;
                if (typeof c === "string" && c !== "Warmup") {
                    firstPrompt = c;
                }
            }
        }
    }

    const sessionId = path.basename(filepath, ".jsonl");

    return { sessionId, msgCount, slug, agentName, customTitle, aiTitle, summary, firstPrompt, created, modified };
}

/** Return the best description for a session. */
export function sessionDescription(s: Session): string {
    return s.customTitle || s.aiTitle || s.summary || s.firstPrompt.slice(0, 60);
}

/** Parse all sessions in a project directory. */
export function listSessions(projectDir: string): Session[] {
    const sessions: Session[] = [];
    for (const fname of fs.readdirSync(projectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const s = parseSession(path.join(projectDir, fname));
        if (s.msgCount > 0) sessions.push(s);
    }
    return sessions;
}

/** List all project directories with their decoded paths. */
export function listProjectDirs(): ProjectDir[] {
    if (!fs.existsSync(PROJECTS_DIR)) return [];

    const results: ProjectDir[] = [];
    for (const entry of fs.readdirSync(PROJECTS_DIR).sort()) {
        const fullPath = path.join(PROJECTS_DIR, entry);
        if (!fs.statSync(fullPath).isDirectory()) continue;
        results.push({
            dirName: entry,
            decodedPath: dirnameToPath(entry),
            fullPath,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// File modification time preservation
// ---------------------------------------------------------------------------

/** Execute a function while preserving a file's mtime. */
export async function preserveMtime(filepath: string, fn: () => void | Promise<void>): Promise<void> {
    const stat = fs.statSync(filepath);
    const originalAtime = stat.atime;
    const originalMtime = stat.mtime;
    await fn();
    fs.utimesSync(filepath, originalAtime, originalMtime);
}
