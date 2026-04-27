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
    searchInSession,
    getCurrentSession,
    generateSessionNonce,
} from "./find-session.js";
export { getSynonyms, expandWithSynonyms } from "./synonyms.js";
export { titleProject, titleAllProjects, titleProjectByPath, renameSession, renameSessionAgentName, renameSessionSlug } from "./title-sessions.js";
export { scanProject, scanAllProjects, scanProjectByPath, requireDetectSecrets } from "./redact-secrets.js";
export { copyHistory, deleteHistory, moveHistory, cleanBrokenResumeArtifacts } from "./set-history.js";
export {
    getKey,
    storeKey,
    deleteKey,
    copyKey,
    getDefaultKey,
    copyDefaultKey,
    captureDefaultKey,
    getCapturedKey,
    listCapturedKeys,
    getKeyName,
    saveKeyName,
    getKeyLabel,
    listKeychainEntries,
    pruneOrphanedKeyNames,
    validateKey,
    CENTRAL_ENVRC_PATH,
    ensureEnvrc,
    removeEnvrcSnippet,
    getKeyMeta,
    storeKeyMeta,
    deleteKeyMeta,
    fetchAndStoreKeyMeta,
    fetchOrgId,
    getAdminCreds,
    storeAdminCreds,
    deleteAdminCreds,
    hasZshHook,
    installZshHook,
} from "./set-key.js";
export {
    checkCommandSafety,
    checkToolSafety,
    processHookInput,
    isFastApprove,
    extractTaskContext,
    getBlockState,
    incrementBlockCount,
    resetConsecutiveBlocks,
    shouldDegradeToPrompt,
} from "./llm-safety-check.js";
export { getClaudeStatus, parseStatusRss, parseStatusSummary } from "./claude-status.js";
export { getSessionCost, getSessionInfo, calculateCost, MODEL_PRICING } from "./session-cost.js";
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
    configGet,
    configSet,
    ensureConfig,
    getConfigFile,
    CLAUDE_DIR,
    PROJECTS_DIR,
    HISTORY_FILE,
    DEFAULT_MODEL,
} from "./utils.js";
export { exportSession, importSession } from "./share-session.js";
export type { ExportOptions, ExportResult, ImportOptions, ImportResult } from "./share-session.js";
export { parseChangelog, getVersion, diffVersions, searchChangelog, fetchChangelog, compareSemver } from "./changelog.js";
export { openSession } from "./open-session.js";
export type { OpenSessionOptions } from "./open-session.js";
export type * from "./types.js";
