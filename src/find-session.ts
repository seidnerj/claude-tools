// ---------------------------------------------------------------------------
// Search Claude Code conversation history by text or LLM
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
    SearchMatch,
    ProjectSearchResult,
    LlmSearchResult,
    ProjectDir,
    SearchOptions,
    SessionMessage,
    ReadSessionResult,
    SessionSearchMatch,
    SessionSearchResult,
} from "./types.js";
import {
    PROJECTS_DIR,
    extractStrings,
    listProjectDirs,
    listSessions,
    parseSession,
    pathToDirname,
    requireProjectsDir,
    sessionDescription,
    callClaude,
    requireApiKey,
    DEFAULT_MODEL,
} from "./utils.js";
import { expandWithSynonyms } from "./synonyms.js";

// ---------------------------------------------------------------------------
// Session file lookup
// ---------------------------------------------------------------------------

/** Locate a session file by ID. Searches a specific project or all projects. */
export function findSessionFile(sessionId: string, projectPath?: string): { filepath: string; projectPath: string } {
    requireProjectsDir();

    if (projectPath) {
        const resolved = path.resolve(projectPath).replace(/\/+$/, "");
        const dirName = pathToDirname(resolved);
        const projectDir = path.join(PROJECTS_DIR, dirName);
        const filepath = path.join(projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(filepath)) {
            return { filepath, projectPath: resolved };
        }
        throw new Error(`Session ${sessionId} not found in project: ${resolved}`);
    }

    for (const pd of listProjectDirs()) {
        const filepath = path.join(pd.fullPath, `${sessionId}.jsonl`);
        if (fs.existsSync(filepath)) {
            return { filepath, projectPath: pd.decodedPath };
        }
    }

    throw new Error(`Session ${sessionId} not found in any project`);
}

// ---------------------------------------------------------------------------
// Read session messages
// ---------------------------------------------------------------------------

function extractMessageContent(entry: Record<string, unknown>): string {
    const t = entry.type as string | undefined;

    if (t === "user" || t === "assistant") {
        const msg = entry.message as { content?: unknown } | undefined;
        const c = msg?.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
            return c
                .map((block: unknown) => {
                    if (typeof block === "string") return block;
                    if (block && typeof block === "object" && "text" in block) {
                        return (block as { text: string }).text;
                    }
                    return "";
                })
                .filter(Boolean)
                .join("\n");
        }
        return "";
    }

    if (t === "summary") return (entry.summary as string) || "";
    if (t === "custom-title") return (entry.customTitle as string) || "";
    if (t === "ai-title") return (entry.aiTitle as string) || "";

    return "";
}

/** Read messages from a session with pagination. */
export function readSession(sessionId: string, options?: { projectPath?: string; offset?: number; limit?: number }): ReadSessionResult {
    const { filepath, projectPath } = findSessionFile(sessionId, options?.projectPath);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;

    const allMessages: SessionMessage[] = [];
    const content = fs.readFileSync(filepath, "utf-8");
    let index = 0;

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
        if (!t) continue;

        const msgContent = extractMessageContent(entry);
        const timestamp = (entry.timestamp as string) || "";

        allMessages.push({ index, type: t, timestamp, content: msgContent });
        index++;
    }

    const paged = allMessages.slice(offset, offset + limit);

    return {
        sessionId,
        projectPath,
        totalMessages: allMessages.length,
        offset,
        limit,
        messages: paged,
    };
}

// ---------------------------------------------------------------------------
// Search within a single session
// ---------------------------------------------------------------------------

/** Search within a specific session for text matches. */
export function searchInSession(
    sessionId: string,
    searchText: string,
    options?: { projectPath?: string; caseSensitive?: boolean; contextChars?: number }
): SessionSearchResult {
    const { filepath, projectPath } = findSessionFile(sessionId, options?.projectPath);
    const caseSensitive = options?.caseSensitive ?? false;
    const contextChars = options?.contextChars ?? 120;
    const searchLower = caseSensitive ? searchText : searchText.toLowerCase();

    const matches: SessionSearchMatch[] = [];
    let totalMatches = 0;
    const content = fs.readFileSync(filepath, "utf-8");
    let messageIndex = 0;

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
        if (!t) continue;

        const timestamp = (entry.timestamp as string) || "";
        let matchCount = 0;
        const snippets: string[] = [];

        for (const text of extractStrings(entry)) {
            const hasMatch = caseSensitive ? text.includes(searchText) : text.toLowerCase().includes(searchLower);
            if (hasMatch) {
                matchCount++;
                if (snippets.length < 5) {
                    const snippet = findSnippet(text, searchText, searchLower, caseSensitive, contextChars);
                    if (snippet && !snippets.includes(snippet)) {
                        snippets.push(snippet);
                    }
                }
            }
        }

        if (matchCount > 0) {
            totalMatches += matchCount;
            matches.push({ messageIndex, messageType: t, timestamp, matchCount, snippets });
        }

        messageIndex++;
    }

    return { sessionId, projectPath, totalMatches, matches };
}

// ---------------------------------------------------------------------------
// Get current session ID (nonce-based)
// ---------------------------------------------------------------------------

/** Identify the current session by searching for a unique nonce.
 *  The nonce must appear in the caller's tool response (written to the JSONL).
 */
export function getCurrentSession(nonce: string, projectPath?: string): { sessionId: string; projectPath: string } {
    requireProjectsDir();

    const projectDirs = projectPath
        ? (() => {
              const resolved = path.resolve(projectPath).replace(/\/+$/, "");
              const dirName = pathToDirname(resolved);
              const fullPath = path.join(PROJECTS_DIR, dirName);
              if (!fs.existsSync(fullPath)) throw new Error(`No Claude history found for: ${resolved}`);
              return [{ dirName, decodedPath: resolved, fullPath }];
          })()
        : listProjectDirs();

    for (const pd of projectDirs) {
        for (const fname of fs.readdirSync(pd.fullPath).sort()) {
            if (!fname.endsWith(".jsonl")) continue;
            const filepath = path.join(pd.fullPath, fname);
            const content = fs.readFileSync(filepath, "utf-8");
            if (content.includes(nonce)) {
                return {
                    sessionId: path.basename(fname, ".jsonl"),
                    projectPath: pd.decodedPath,
                };
            }
        }
    }

    throw new Error("Could not identify current session (nonce not found)");
}

/** Generate a unique nonce for session identification. */
export function generateSessionNonce(): string {
    return `__session_probe_${crypto.randomUUID()}__`;
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

function findSnippet(text: string, searchText: string, searchLower: string, caseSensitive: boolean, maxContext = 120): string | null {
    const idx = caseSensitive ? text.indexOf(searchText) : text.toLowerCase().indexOf(searchLower);
    if (idx === -1) return null;

    const lineStart = Math.max(0, text.lastIndexOf("\n", idx) + 1);
    let lineEnd = text.indexOf("\n", idx);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).trim();

    if (line.length <= maxContext) return line;

    const matchPos = idx - lineStart;
    const half = Math.floor(maxContext / 2);
    let start = Math.max(0, matchPos - half);
    let end = Math.min(line.length, start + maxContext);
    if (end === line.length) start = Math.max(0, end - maxContext);
    const snippet = line.slice(start, end);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < line.length ? "..." : "";
    return prefix + snippet + suffix;
}

function searchProjectForTerms(projectDir: string, projectName: string, terms: string[], options?: SearchOptions): ProjectSearchResult {
    requireProjectsDir();

    const caseSensitive = options?.caseSensitive ?? false;
    const maxContext = options?.contextChars ?? 120;
    const maxSnippets = options?.maxSnippets ?? 3;
    const excludeSessions = new Set(options?.excludeSessions ?? []);
    const matches: SearchMatch[] = [];

    for (const fname of fs.readdirSync(projectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const sessionId = path.basename(fname, ".jsonl");
        if (excludeSessions.has(sessionId)) continue;

        const filepath = path.join(projectDir, fname);
        const s = parseSession(filepath);

        if (options?.after && s.modified < options.after) continue;
        if (options?.before && s.created > options.before) continue;

        const desc = sessionDescription(s);
        let matchCount = 0;
        const snippets: string[] = [];

        const content = fs.readFileSync(filepath, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let entry: unknown;
            try {
                entry = JSON.parse(trimmed);
            } catch {
                continue;
            }

            for (const text of extractStrings(entry)) {
                for (const term of terms) {
                    const searchLower = caseSensitive ? term : term.toLowerCase();
                    const hasMatch = caseSensitive ? text.includes(term) : text.toLowerCase().includes(searchLower);
                    if (hasMatch) {
                        matchCount++;
                        if (snippets.length < maxSnippets) {
                            const snippet = findSnippet(text, term, searchLower, caseSensitive, maxContext);
                            if (snippet && !snippets.includes(snippet)) {
                                snippets.push(snippet);
                            }
                        }
                    }
                }
            }
        }

        if (matchCount > 0) {
            matches.push({
                sessionId: s.sessionId,
                msgCount: s.msgCount,
                description: desc,
                created: s.created.slice(0, 10),
                modified: s.modified.slice(0, 10),
                matchCount,
                snippets,
            });
        }
    }

    return { projectName, matches };
}

/** Search a single project directory for text matches. */
export function searchProject(projectDir: string, projectName: string, searchText: string, options?: SearchOptions): ProjectSearchResult {
    const terms = options?.fuzzy ? expandWithSynonyms(searchText) : [searchText];
    return searchProjectForTerms(projectDir, projectName, terms, options);
}

/** Search all projects for text matches. */
export function searchAllProjects(searchText: string, options?: SearchOptions): ProjectSearchResult[] {
    requireProjectsDir();
    return listProjectDirs().map((pd) => searchProject(pd.fullPath, pd.decodedPath, searchText, options));
}

/** Search a specific project path for text matches. */
export function searchProjectByPath(projectPath: string, searchText: string, options?: SearchOptions): ProjectSearchResult {
    requireProjectsDir();
    const resolved = path.resolve(projectPath).replace(/\/+$/, "");
    const dirName = pathToDirname(resolved);
    const projectDir = path.join(PROJECTS_DIR, dirName);

    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`No Claude history found for: ${resolved}`);
    }

    return searchProject(projectDir, resolved, searchText, options);
}

// ---------------------------------------------------------------------------
// LLM search
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(
    "the a an in on at to for of with by from is was are were be been being have has had do does did will would could should may might can shall this that these those it its which who whom what where when how why and or but not no nor if then else about any all each every some most other into through during before after above below between up down out off over under again i me my we our you your he she they them his her their session sessions mention mentioned using used did find where discuss something like".split(
        " "
    )
);

function extractQueryTerms(query: string): string[] {
    return (query.toLowerCase().match(/\w+/g) || []).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function textSearchSession(filepath: string, terms: string[]): Map<string, { count: number; snippets: string[] }> {
    const results = new Map<string, { count: number; snippets: string[] }>();

    const content = fs.readFileSync(filepath, "utf-8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: unknown;
        try {
            entry = JSON.parse(trimmed);
        } catch {
            continue;
        }

        for (const text of extractStrings(entry)) {
            const textLower = text.toLowerCase();
            for (const term of terms) {
                if (!textLower.includes(term)) continue;
                const existing = results.get(term) || { count: 0, snippets: [] };
                let pos = 0;
                while ((pos = textLower.indexOf(term, pos)) !== -1) {
                    existing.count++;
                    pos += term.length;
                }
                if (existing.snippets.length < 3) {
                    const idx = textLower.indexOf(term);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + term.length + 60);
                    const snip = text.slice(start, end).replace(/\n/g, " ").trim();
                    if (snip && !existing.snippets.includes(snip)) {
                        existing.snippets.push(snip);
                    }
                }
                results.set(term, existing);
            }
        }
    }

    return results;
}

/** LLM-powered search across projects.
 *
 * Phase 1: Extract keywords from query, text-search all sessions (fast, local).
 * Phase 2: Send results to Claude API for ranking/summarization.
 */
export async function llmSearch(projectDirs: ProjectDir[], query: string, apiKey?: string, model?: string): Promise<LlmSearchResult> {
    const resolvedApiKey = apiKey ?? requireApiKey();
    const resolvedModel = model ?? DEFAULT_MODEL;

    const terms = extractQueryTerms(query);
    if (terms.length === 0) {
        throw new Error("Could not extract search terms from query. Try rephrasing.");
    }

    const allHits: Array<{
        projectName: string;
        session: ReturnType<typeof parseSession>;
        termResults: Map<string, { count: number; snippets: string[] }>;
    }> = [];

    for (const pd of projectDirs) {
        let sessions;
        try {
            sessions = listSessions(pd.fullPath);
        } catch {
            continue;
        }
        for (const s of sessions) {
            const filepath = path.join(pd.fullPath, `${s.sessionId}.jsonl`);
            const termResults = textSearchSession(filepath, terms);
            if (termResults.size > 0) {
                allHits.push({ projectName: pd.decodedPath, session: s, termResults });
            }
        }
    }

    if (allHits.length === 0) {
        return { analysis: "No matches found in any session.", hitCount: 0 };
    }

    const hitLines: string[] = [];
    for (let i = 0; i < allHits.length; i++) {
        const { projectName, session: s, termResults } = allHits[i];
        const desc = sessionDescription(s) || "(no description)";
        const cr = s.created.slice(0, 10);
        const mod = s.modified.slice(0, 10);
        const hitsStr = [...termResults.entries()].map(([t, { count }]) => `"${t}" (${count}x)`).join(", ");
        const allSnippets: string[] = [];
        for (const [, { snippets }] of termResults) {
            allSnippets.push(...snippets);
        }
        const snipStr =
            allSnippets.length > 0
                ? "\n    Snippets: " +
                  allSnippets
                      .slice(0, 3)
                      .map((s) => s.slice(0, 100))
                      .join(" | ")
                : "";
        hitLines.push(
            `${i + 1}. Project: ${projectName}\n   Session: ${desc} (${s.msgCount} msgs, ${cr} -> ${mod})\n   Matches: ${hitsStr}${snipStr}`
        );
    }

    const prompt =
        "Below are text search results from Claude Code session history. " +
        "Each entry shows a session where keywords from the user's query were found, " +
        "with match counts and text snippets.\n\n" +
        "Search results:\n" +
        hitLines.join("\n\n") +
        "\n\n" +
        `User's question: ${query}\n\n` +
        "Based on these search results, provide a concise answer to the user's question.\n" +
        "For each relevant session, write a specific one-line description of what happened " +
        "in that session. Use the snippets to infer real context.\n" +
        "Group results by project if multiple projects match. " +
        "Ignore noise matches (e.g. a term only in a directory listing or file path).";

    const analysis = await callClaude(resolvedApiKey, resolvedModel, [{ role: "user", content: prompt }], 2048);
    return { analysis, hitCount: allHits.length };
}

/** LLM search across all projects. */
export async function llmSearchAll(query: string, apiKey?: string, model?: string): Promise<LlmSearchResult> {
    requireProjectsDir();
    return llmSearch(listProjectDirs(), query, apiKey, model);
}

/** LLM search for a specific project path. */
export async function llmSearchByPath(projectPath: string, query: string, apiKey?: string, model?: string): Promise<LlmSearchResult> {
    requireProjectsDir();
    const resolved = path.resolve(projectPath).replace(/\/+$/, "");
    const dirName = pathToDirname(resolved);
    const projectDir = path.join(PROJECTS_DIR, dirName);

    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`No Claude history found for: ${resolved}`);
    }

    return llmSearch([{ dirName, decodedPath: resolved, fullPath: projectDir }], query, apiKey, model);
}
