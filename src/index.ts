// ---------------------------------------------------------------------------
// Library entry point - re-exports all modules for use as a dependency
// ---------------------------------------------------------------------------

export {
    searchProject,
    searchAllProjects,
    searchProjectByPath,
    llmSearch,
    llmSearchAll,
    llmSearchByPath,
    findSessionFile,
    readSession,
    searchSession,
    getCurrentSession,
    generateSessionNonce,
} from "./find-session.js";
export { getSynonyms, expandWithSynonyms } from "./synonyms.js";
export { titleProject, titleAllProjects, titleProjectByPath } from "./title-sessions.js";
export { scanProject, scanAllProjects, scanProjectByPath, requireDetectSecrets } from "./redact-secrets.js";
export { copyHistory, deleteHistory, moveHistory, cleanBrokenResumeArtifacts } from "./set-history.js";
export {
    getKey,
    storeKey,
    deleteKey,
    copyKey,
    getDefaultKey,
    copyDefaultKey,
    getKeyName,
    saveKeyName,
    getKeyLabel,
    listKeychainEntries,
    ensureEnvrc,
    removeEnvrcSnippet,
} from "./set-key.js";
export { checkCommandSafety, processHookInput } from "./llm-safety-check.js";
export {
    readClaudeConfig,
    writeClaudeConfig,
    backupClaudeConfig,
    restoreMcpBackup,
    listMcpServers,
    getMcpServer,
    addMcpServer,
    updateMcpServer,
    removeMcpServer,
} from "./mcp-servers.js";
export {
    pathToDirname,
    dirnameToPath,
    requireProjectsDir,
    getApiKey,
    requireApiKey,
    callClaude,
    extractStrings,
    parseSession,
    sessionDescription,
    listSessions,
    listProjectDirs,
    preserveMtime,
    CLAUDE_DIR,
    PROJECTS_DIR,
    HISTORY_FILE,
    DEFAULT_MODEL,
} from "./utils.js";
export type * from "./types.js";
