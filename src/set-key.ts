// ---------------------------------------------------------------------------
// Public surface for per-directory auth management.
// Implementation lives in src/auth/ submodules; this file re-exports the
// API surface used by claude-set-key, claude-set-chain, tests, and the MCP layer.
// ---------------------------------------------------------------------------

export {
    requireMacOS,
    keyHash,
    encodedDir,
    keychainName,
    securityFindPassword,
    securityAddPassword,
    securityDeletePassword,
} from "./auth/keychain.js";

export {
    getKeyLabel,
    getKeyName,
    saveKeyName,
    getKey,
    storeKey,
    deleteKey,
    copyKey,
    getDefaultKey,
    copyDefaultKey,
    captureDefaultKey,
    getCapturedKey,
    listCapturedKeys,
    listKeychainEntries,
    pruneOrphanedKeyNames,
} from "./auth/keys.js";

export { getKeyMeta, storeKeyMeta, deleteKeyMeta, getAdminCreds, storeAdminCreds, deleteAdminCreds } from "./auth/metadata.js";

export { fetchOrgId, fetchAndStoreKeyMeta } from "./auth/console-api.js";

export { validateKey } from "./auth/validate.js";

export { CLAUDE_TOOLS_DIR, CENTRAL_ENVRC_PATH, ENVRC_SOURCE_LINE, ENVRC_SNIPPET, ensureEnvrc, removeEnvrcSnippet } from "./auth/envrc.js";

export { hasZshHook, installZshHook } from "./auth/zsh-hook.js";
