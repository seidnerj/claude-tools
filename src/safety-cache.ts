// ---------------------------------------------------------------------------
// In-session approval cache for the safety classifier.
//
// Caches APPROVE decisions only - re-evaluating denies and prompts on every
// occurrence is the safe default. Keyed by sha256 of toolName + sorted-keys
// JSON of toolInput so equivalent inputs collide regardless of key order.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { SafetyCheckResult, ContextLevel } from "./types.js";

const DEFAULT_MAX_ENTRIES = 256;

function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value === null || typeof value !== "object") return value;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeysDeep(obj[k]);
    return out;
}

function hashKey(toolName: string, toolInput: Record<string, unknown>, contextLevel: ContextLevel): string {
    const payload = JSON.stringify({ tool: toolName, input: sortKeysDeep(toolInput), context_level: contextLevel });
    return createHash("sha256").update(payload).digest("hex");
}

export class ApprovalCache {
    private store = new Map<string, SafetyCheckResult>();

    constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

    get(toolName: string, toolInput: Record<string, unknown>, contextLevel: ContextLevel): SafetyCheckResult | null {
        const key = hashKey(toolName, toolInput, contextLevel);
        const hit = this.store.get(key);
        if (!hit) return null;
        // Refresh LRU order
        this.store.delete(key);
        this.store.set(key, hit);
        return hit;
    }

    set(toolName: string, toolInput: Record<string, unknown>, contextLevel: ContextLevel, result: SafetyCheckResult): void {
        if (result.decision !== "approve") return;
        const key = hashKey(toolName, toolInput, contextLevel);
        this.store.delete(key);
        this.store.set(key, result);
        while (this.store.size > this.maxEntries) {
            const oldest = this.store.keys().next().value;
            if (oldest === undefined) break;
            this.store.delete(oldest);
        }
    }

    clear(): void {
        this.store.clear();
    }
}

/** Singleton shared across hook invocations within a single Node process. */
export const approvalCache = new ApprovalCache();
