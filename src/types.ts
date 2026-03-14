// ---------------------------------------------------------------------------
// Shared type definitions for claude-tools
// ---------------------------------------------------------------------------

/** Parsed metadata from a Claude Code session .jsonl file */
export interface Session {
    sessionId: string;
    msgCount: number;
    customTitle: string;
    aiTitle: string;
    summary: string;
    firstPrompt: string;
    created: string;
    modified: string;
}

/** A project directory entry from ~/.claude/projects/ */
export interface ProjectDir {
    /** Raw directory name (dash-delimited) */
    dirName: string;
    /** Decoded absolute path */
    decodedPath: string;
    /** Full path to the project directory under ~/.claude/projects/ */
    fullPath: string;
}

/** A text search match within a session */
export interface SearchMatch {
    sessionId: string;
    msgCount: number;
    description: string;
    created: string;
    modified: string;
    matchCount: number;
    snippets: string[];
}

/** Result of searching a project for text */
export interface ProjectSearchResult {
    projectName: string;
    matches: SearchMatch[];
}

/** Result of LLM-powered search across projects */
export interface LlmSearchResult {
    /** The LLM's analysis/summary */
    analysis: string;
    /** Number of sessions that had keyword matches */
    hitCount: number;
}

/** A detected secret in a session file */
export interface SecretFinding {
    filepath: string;
    lineNumber: number;
    secretType: string;
    secretValue: string;
    redactedValue: string;
}

/** Result of scanning a project for secrets */
export interface ScanResult {
    projectName: string;
    findings: SecretFinding[];
    /** Path to backup directory (only if redaction was performed) */
    backupDir?: string;
    /** Number of secrets actually redacted */
    redactedCount?: number;
}

/** Result of moving history from one path to another */
export interface MoveHistoryResult {
    oldPath: string;
    newPath: string;
    sessionFilesUpdated: number;
    sessionsIndexUpdated: boolean;
    historyFileUpdated: boolean;
    brokenArtifactsCleaned: number;
}

/** Result of generating a title for a session */
export interface TitleResult {
    sessionId: string;
    title: string;
}

/** Result of titling sessions in a project */
export interface TitleProjectResult {
    projectName: string;
    titles: TitleResult[];
    skipped: number;
}

/** A keychain entry for a Claude Code API key */
export interface KeychainEntry {
    /** Base64-encoded directory path */
    encodedDir: string;
    /** Decoded directory path */
    dirPath: string;
    /** Whether the directory still exists on disk */
    exists: boolean;
}

/** Result of listing keychain entries */
export interface KeychainListResult {
    /** Key for the current directory (if any) */
    currentKey?: { label: string };
    /** Keys for other directories */
    otherKeys: Array<KeychainEntry & { label: string }>;
    /** Whether a default "Claude Code" key exists */
    hasDefaultKey: boolean;
}

/** LLM safety check decision */
export interface SafetyCheckResult {
    decision: "approve" | "deny" | "prompt" | "needs_context";
    reason: string;
    files?: string[];
}

/** Input from the Claude Code hook system (PreToolUse) */
export interface HookInput {
    tool_name: string;
    tool_input: { command?: string; description?: string };
}

/** Output to return to the Claude Code hook system */
export interface HookOutput {
    decision: "allow" | "deny";
    reason: string;
}
