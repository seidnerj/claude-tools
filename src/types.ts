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

/** Options for text search across sessions */
export interface SearchOptions {
    caseSensitive?: boolean;
    contextChars?: number;
    maxSnippets?: number;
    after?: string;
    before?: string;
    fuzzy?: boolean;
    excludeSessions?: string[];
}

/** A single message from a session file */
export interface SessionMessage {
    index: number;
    type: string;
    timestamp: string;
    content: string;
}

/** Result of reading messages from a session */
export interface ReadSessionResult {
    sessionId: string;
    projectPath: string;
    totalMessages: number;
    offset: number;
    limit: number;
    messages: SessionMessage[];
}

/** A search match within a single session message */
export interface SessionSearchMatch {
    messageIndex: number;
    messageType: string;
    timestamp: string;
    matchCount: number;
    snippets: string[];
}

/** Result of searching within a single session */
export interface SessionSearchResult {
    sessionId: string;
    projectPath: string;
    totalMatches: number;
    matches: SessionSearchMatch[];
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

/** Result of copying history from one path to another */
export interface CopyHistoryResult {
    sourcePath: string;
    destPath: string;
    sessionFilesUpdated: number;
    sessionsIndexUpdated: boolean;
    historyFileUpdated: boolean;
    brokenArtifactsCleaned: number;
}

/** Result of deleting history for a path */
export interface DeleteHistoryResult {
    targetPath: string;
    historyFileUpdated: boolean;
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

/** A captured "Claude Code Key N" keychain entry */
export interface CapturedKeyEntry {
    /** 1-based slot number */
    slot: number;
    /** Display label (user-defined name, or truncated key) */
    label: string;
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

/** Configuration for a single MCP server */
export interface McpServerConfig {
    type?: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}

/** An MCP server entry with its name and scope */
export interface McpServerEntry {
    name: string;
    config: McpServerConfig;
    scope: "global" | "project";
    projectPath?: string;
}

/** Result of an MCP server mutation operation */
export interface McpServerResult {
    success: boolean;
    backupPath?: string;
    server?: McpServerEntry;
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
