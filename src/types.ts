// ---------------------------------------------------------------------------
// Shared type definitions for claude-tools
// ---------------------------------------------------------------------------

/** Parsed metadata from a Claude Code session .jsonl file */
export interface Session {
    sessionId: string;
    msgCount: number;
    slug: string;
    agentName: string;
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
    /** Which sessions were copied (undefined = all sessions in the project) */
    sessionIds?: string[];
    /** Requested session IDs that were not found in the source project */
    sessionsNotFound?: string[];
}

/** Result of deleting history for a path */
export interface DeleteHistoryResult {
    targetPath: string;
    historyFileUpdated: boolean;
    /** Which sessions were deleted (undefined = all sessions in the project) */
    sessionIds?: string[];
    /** Requested session IDs that were not found in the project */
    sessionsNotFound?: string[];
    /** Warnings about potentially destructive operations (e.g. operating on a live session) */
    warnings?: string[];
}

/** Result of moving history from one path to another */
export interface MoveHistoryResult {
    oldPath: string;
    newPath: string;
    sessionFilesUpdated: number;
    sessionsIndexUpdated: boolean;
    historyFileUpdated: boolean;
    brokenArtifactsCleaned: number;
    /** Which sessions were moved (undefined = all sessions in the project) */
    sessionIds?: string[];
    /** Requested session IDs that were not found in the source project */
    sessionsNotFound?: string[];
    /** Warnings about potentially destructive operations (e.g. operating on a live session) */
    warnings?: string[];
}

/** Result of renaming a session */
export interface RenameResult {
    sessionId: string;
    newTitle?: string;
    newSlug?: string;
    newAgentName?: string;
    projectPath: string;
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

/** Result of validating an API key against the Anthropic API */
export interface KeyValidationResult {
    valid: boolean;
    /** Present when valid is false */
    error?: "invalid_key" | "quota_exhausted" | "network_error" | "unknown";
    /** Raw error message from the API */
    message?: string;
    /** ISO date string for when quota resets (only present when error is "quota_exhausted") */
    quotaResetsAt?: string;
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
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
}

/** Input from the Claude Code hook system (PreToolUse) */
export interface HookInput {
    tool_name: string;
    tool_input: Record<string, unknown>;
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    permission_mode?: string;
    tool_use_id?: string;
}

/** Output to return to the Claude Code hook system */
export interface HookOutput {
    decision: "allow" | "deny";
    reason: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
}

/** Safety hook configuration stored in ~/.claude/key-config.json under "safety" */
export interface SafetyConfig {
    model: string;
    context_level: "full" | "user-only" | "none";
}

/** Block count state for graceful degradation, persisted per session */
export interface BlockState {
    consecutiveDenials: number;
    totalDenials: number;
}

/** A single status update within an incident timeline */
export interface StatusUpdate {
    /** Timestamp of this update (ISO 8601) */
    timestamp: string;
    /** Status label (e.g. "Investigating", "Monitoring", "Resolved") */
    status: string;
    /** Description text for this update */
    message: string;
}

/** A single incident from the Claude status page */
export interface StatusIncident {
    /** Incident title */
    title: string;
    /** Link to the incident page */
    link: string;
    /** Publication date (ISO 8601) */
    pubDate: string;
    /** Current status (last update's status label) */
    currentStatus: string;
    /** Timeline of status updates, newest first */
    updates: StatusUpdate[];
}

/** A Claude service component and its current status */
export interface StatusComponent {
    /** Component name (e.g. "claude.ai", "Claude API") */
    name: string;
    /** Current status (operational, degraded_performance, partial_outage, major_outage) */
    status: string;
}

/** Real-time status from the summary API */
export interface StatusSummary {
    /** Overall status indicator (none, minor, major, critical) */
    indicator: string;
    /** Human-readable status description (e.g. "All Systems Operational") */
    description: string;
    /** Per-component statuses */
    components: StatusComponent[];
    /** Currently active incidents (empty when all clear) */
    activeIncidents: string[];
    /** Scheduled maintenance windows (empty when none) */
    scheduledMaintenances: string[];
    /** When the status page was last updated (ISO 8601) */
    updatedAt: string;
}

/** Result of fetching Claude status */
export interface StatusResult {
    /** Real-time status summary (null if summary fetch failed but RSS succeeded) */
    summary: StatusSummary | null;
    /** Whether the overall status appears operational */
    operational: boolean;
    /** Number of incidents returned */
    incidentCount: number;
    /** Recent incidents from the RSS history feed, newest first */
    incidents: StatusIncident[];
    /** When the RSS feed was last published (ISO 8601) */
    feedDate: string;
}

/** Token usage aggregated by model */
export interface ModelUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    webSearchRequests: number;
    cost: number;
}

/** Duration statistics for a session */
export interface SessionDurations {
    apiDurationMs: number;
    wallDurationMs: number;
}

/** Complete cost breakdown for a session */
export interface SessionCost {
    sessionId: string;
    projectPath: string;
    totalCost: number;
    durations: SessionDurations;
    models: ModelUsage[];
}

/** Session naming levels */
export interface SessionNames {
    /** Internal three-word identifier (e.g. "crispy-rolling-anchor") */
    slug: string;
    /** Name shown in the terminal status bar (e.g. "export-conversation-transcript") */
    agentName: string;
    /** User-set or AI-generated custom title */
    customTitle: string;
    /** AI-generated title */
    aiTitle: string;
    /** Auto-generated summary */
    summary: string;
    /** Best available description (customTitle > aiTitle > summary > firstPrompt) */
    description: string;
}

/** Complete session information - names, cost, and stats */
export interface SessionInfo {
    sessionId: string;
    projectPath: string;
    names: SessionNames;
    msgCount: number;
    firstPrompt: string;
    created: string;
    modified: string;
    totalCost: number;
    durations: SessionDurations;
    models: ModelUsage[];
}
