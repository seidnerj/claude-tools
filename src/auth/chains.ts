// ---------------------------------------------------------------------------
// Inference chain configs: one JSON file per chain at
// ~/.claude-tools/chains/<chain-id>.json
//
// Each chain file holds claude-tools metadata (`id`, `name`) plus the
// inference-modes schema fields (`accounts`, `chain`). Unknown fields are
// ignored by the consuming binary.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_TOOLS_DIR } from "./envrc.js";

export const CHAINS_DIR = path.join(CLAUDE_TOOLS_DIR, "chains");

export interface AdminSessionKeys {
    api?: string;
    subscription?: string;
}

export interface Account {
    adminSessionKeys?: AdminSessionKeys;
    [key: string]: unknown;
}

export interface RetryPolicy {
    waitForReset?: boolean;
}

export interface PoolEntry {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    [key: string]: unknown;
}

export interface KeyEntry {
    key: string;
    name?: string;
}

export interface ChainTier {
    provider: string;
    account?: string;
    model?: string;
    retry?: RetryPolicy;
    pool?: PoolEntry[];
    keys?: KeyEntry[];
    [key: string]: unknown;
}

export interface ChainConfig {
    id: string;
    name?: string;
    accounts?: Record<string, Account>;
    chain: ChainTier[];
}

function ensureChainsDir(): void {
    if (!fs.existsSync(CHAINS_DIR)) {
        fs.mkdirSync(CHAINS_DIR, { recursive: true });
    }
}

export function chainPath(chainId: string): string {
    return path.join(CHAINS_DIR, `${chainId}.json`);
}

export function listChainIds(): string[] {
    if (!fs.existsSync(CHAINS_DIR)) return [];
    return fs
        .readdirSync(CHAINS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
}

export function readChain(chainId: string): ChainConfig | null {
    const p = chainPath(chainId);
    if (!fs.existsSync(p)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<ChainConfig>;
        if (!Array.isArray(raw.chain)) return null;
        return {
            id: raw.id ?? chainId,
            name: raw.name,
            accounts: raw.accounts,
            chain: raw.chain,
        };
    } catch {
        return null;
    }
}

export function writeChain(config: ChainConfig): void {
    ensureChainsDir();
    if (!config.id || !/^[a-zA-Z0-9_-]+$/.test(config.id)) {
        throw new Error(`Invalid chain id: ${JSON.stringify(config.id)}. Use letters, digits, dash, underscore.`);
    }
    if (!Array.isArray(config.chain) || config.chain.length === 0) {
        throw new Error("Chain must contain at least one tier.");
    }
    fs.writeFileSync(chainPath(config.id), JSON.stringify(config, null, 2) + "\n");
}

export function deleteChain(chainId: string): boolean {
    const p = chainPath(chainId);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}

export function chainExists(chainId: string): boolean {
    return fs.existsSync(chainPath(chainId));
}

export function listChains(): ChainConfig[] {
    return listChainIds()
        .map((id) => readChain(id))
        .filter((c): c is ChainConfig => c !== null);
}
