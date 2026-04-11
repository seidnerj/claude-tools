// ---------------------------------------------------------------------------
// Generate AI titles for untitled Claude Code sessions
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { RenameResult, TitleResult, TitleProjectResult } from "./types.js";
import { findSessionFile } from "./find-session.js";
import {
    PROJECTS_DIR,
    callClaude,
    listProjectDirs,
    listSessions,
    pathToDirname,
    preserveMtime,
    requireApiKey,
    requireProjectsDir,
    DEFAULT_MODEL,
} from "./utils.js";

const TITLE_PROMPT = `Generate a succinct title for a coding session based on the provided description.

Rules:
- Maximum 6 words.
- Always use imperative mood (e.g. "Add", "Fix", "Refactor", "Implement", "Update", "Debug", "Migrate", "Set up", "Remove", "Improve").
- Use sentence case (capitalize only the first word and proper nouns).
- Be specific about what was done, not vague.
- No articles ("a", "the") unless necessary for clarity.

Good examples:
- "Fix login button on mobile"
- "Add Whisper subtitle generation"
- "Migrate SQLAlchemy models to Mapped"
- "Set up pre-commit hooks"
- "Debug Metabase network connectivity"

Bad examples (do NOT generate these styles):
- "Building a new feature" (gerund, not imperative)
- "Login button fix" (noun phrase, not imperative)
- "Working on the API" (vague, gerund)

Return ONLY the title text. No quotes, no JSON, no explanation.

<description>{description}</description>`;

async function generateTitle(apiKey: string, description: string, model: string): Promise<string | null> {
    try {
        const text = await callClaude(apiKey, model, [{ role: "user", content: TITLE_PROMPT.replace("{description}", description) }], 50);
        let title = text.replace(/^["']|["']$/g, "");
        if (title.includes("I need more") || title.toLowerCase().includes("provide")) return null;
        if (title.length > 60) title = title.slice(0, 57) + "...";
        return title;
    } catch {
        return null;
    }
}

function buildDescription(session: ReturnType<typeof listSessions>[number]): string {
    const parts: string[] = [];
    if (session.summary) parts.push(session.summary);
    if (session.firstPrompt) parts.push(session.firstPrompt.slice(0, 500));
    return parts.join("\n\n");
}

/** Generate titles for untitled sessions in a project directory.
 *
 * @param dryRun If true, generates titles but does not write them to disk.
 */
export async function titleProject(
    projectDir: string,
    projectName: string,
    options?: { apiKey?: string; model?: string; dryRun?: boolean }
): Promise<TitleProjectResult> {
    requireProjectsDir();

    const apiKey = options?.apiKey ?? requireApiKey();
    const model = options?.model ?? DEFAULT_MODEL;
    const dryRun = options?.dryRun ?? false;

    const sessions = listSessions(projectDir);
    const untitled = sessions.filter((s) => !s.customTitle && !s.aiTitle && s.msgCount > 0);

    const titles: TitleResult[] = [];
    let skipped = 0;

    for (const s of untitled) {
        const descText = buildDescription(s);
        if (!descText) {
            skipped++;
            continue;
        }

        const title = await generateTitle(apiKey, descText, model);
        if (!title) {
            skipped++;
            continue;
        }

        if (!dryRun) {
            const filepath = path.join(projectDir, `${s.sessionId}.jsonl`);
            const entry = JSON.stringify({ type: "custom-title", sessionId: s.sessionId, customTitle: title });
            await preserveMtime(filepath, () => {
                fs.appendFileSync(filepath, entry + "\n");
            });
        }

        titles.push({ sessionId: s.sessionId, title });
    }

    return { projectName, titles, skipped };
}

/** Generate titles for untitled sessions across all projects. */
export async function titleAllProjects(options?: { apiKey?: string; model?: string; dryRun?: boolean }): Promise<TitleProjectResult[]> {
    requireProjectsDir();
    const results: TitleProjectResult[] = [];
    for (const pd of listProjectDirs()) {
        results.push(await titleProject(pd.fullPath, pd.decodedPath, options));
    }
    return results;
}

/** Generate titles for untitled sessions in a specific project path. */
export async function titleProjectByPath(
    projectPath: string,
    options?: { apiKey?: string; model?: string; dryRun?: boolean }
): Promise<TitleProjectResult> {
    requireProjectsDir();
    const resolved = path.resolve(projectPath).replace(/\/+$/, "");
    const dirName = pathToDirname(resolved);
    const projectDir = path.join(PROJECTS_DIR, dirName);

    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`No Claude history found for: ${resolved}`);
    }

    return titleProject(projectDir, resolved, options);
}

/** Rename (set a custom title for) a Claude Code session. */
export async function renameSession(sessionId: string, newTitle: string, projectPath?: string): Promise<RenameResult> {
    const { filepath, projectPath: resolvedProject } = findSessionFile(sessionId, projectPath);
    const entry = JSON.stringify({ type: "custom-title", sessionId, customTitle: newTitle });
    await preserveMtime(filepath, () => {
        fs.appendFileSync(filepath, entry + "\n");
    });
    return { sessionId, newTitle, projectPath: resolvedProject };
}

/** Rename the agent name (banner/status bar name) of a session.
 *
 * The agent name is shown in the status bar at the bottom of the terminal
 * (e.g. "export-conversation-transcript"). Like custom titles, it's appended
 * as a new entry - the last agent-name entry wins.
 */
export async function renameSessionAgentName(sessionId: string, newAgentName: string, projectPath?: string): Promise<RenameResult> {
    const { filepath, projectPath: resolvedProject } = findSessionFile(sessionId, projectPath);
    const entry = JSON.stringify({ type: "agent-name", sessionId, agentName: newAgentName });
    await preserveMtime(filepath, () => {
        fs.appendFileSync(filepath, entry + "\n");
    });
    return { sessionId, newAgentName, projectPath: resolvedProject };
}

/** Rename the slug (banner identifier) of a session.
 *
 * Unlike custom titles which are appended as new entries, slugs must be
 * rewritten across all entries in the file since they're stored on each entry.
 */
export async function renameSessionSlug(sessionId: string, newSlug: string, projectPath?: string): Promise<RenameResult> {
    const { filepath, projectPath: resolvedProject } = findSessionFile(sessionId, projectPath);

    await preserveMtime(filepath, () => {
        const content = fs.readFileSync(filepath, "utf-8");
        const lines = content.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            try {
                const entry = JSON.parse(trimmed);
                if (typeof entry.slug === "string") {
                    entry.slug = newSlug;
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        fs.writeFileSync(filepath, rewritten.join("\n"));
    });

    return { sessionId, newSlug, projectPath: resolvedProject };
}
