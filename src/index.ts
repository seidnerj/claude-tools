// ---------------------------------------------------------------------------
// Library entry point - re-exports all modules for use as a dependency
// ---------------------------------------------------------------------------

export { searchProject, searchAllProjects, searchProjectByPath, llmSearch, llmSearchAll, llmSearchByPath } from "./find-session.js";
export { titleProject, titleAllProjects, titleProjectByPath } from "./title-sessions.js";
export { scanProject, scanAllProjects, scanProjectByPath, requireDetectSecrets } from "./redact-secrets.js";
export { moveHistory, cleanBrokenResumeArtifacts } from "./set-history.js";
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
