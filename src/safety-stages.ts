// ---------------------------------------------------------------------------
// Stage runners for the safety classifier.
//
// Two-stage flow: S1 (64 tok XML, no thinking, no ALLOW) -> S2 (4096 tok JSON
// with thinking) on escalation. Single-stage modes: single_fast (256 tok XML)
// or single_thinking (4096 tok JSON with thinking).
// ---------------------------------------------------------------------------

import { configGet, configGetObject } from "./utils.js";
import type { SafetyCheckResult, ClassifierStage, SafetyUserRules, ApiUsage, ApiUsageEntry } from "./types.js";
import { buildSystemPrompt, parseXmlVerdict, buildStageDirective } from "./safety-prompts.js";

/**
 * Sum a list of per-stage usage entries into one combined usage block. When
 * the list is empty, returns undefined so the caller can omit the field.
 * Cache fields are normalized: 0 is preserved (it carries information that
 * caching ran but missed) but missing-on-input becomes 0 in the sum.
 */
export function aggregateUsage(entries: ApiUsageEntry[]): ApiUsage | undefined {
    if (entries.length === 0) return undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreate = 0;
    let cacheRead = 0;
    for (const entry of entries) {
        inputTokens += entry.usage.input_tokens;
        outputTokens += entry.usage.output_tokens;
        cacheCreate += entry.usage.cache_creation_input_tokens ?? 0;
        cacheRead += entry.usage.cache_read_input_tokens ?? 0;
    }
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
    };
}

/** Model name from the LAST entry in a usage list, or undefined for empty list. */
export function lastModel(entries: ApiUsageEntry[]): string | undefined {
    return entries.length > 0 ? entries[entries.length - 1].model : undefined;
}

export const DEFAULT_SAFETY_MODEL = "claude-opus-4-6";
const SAFETY_TIMEOUT_MS = 30_000;

interface StageConfig {
    budget: number;
    stopSequences?: string[];
    useThinking: boolean;
}

const STAGE_CONFIG: Record<ClassifierStage, StageConfig> = {
    s1: { budget: 64, stopSequences: ["</block>"], useThinking: false },
    s2: { budget: 4096, useThinking: true },
    single_fast: { budget: 256, stopSequences: ["</block>"], useThinking: false },
    single_thinking: { budget: 4096, useThinking: true },
};

/**
 * Sentinel reason emitted by runStage when stage="s1" and the model flags the
 * action for escalation. Consumed exclusively by runTwoStage. Direct callers
 * of runStage with stage="s1" must handle this sentinel themselves.
 */
export const S1_ESCALATE_SENTINEL = "__S1_ESCALATE__";

function buildBillingHeaderBlock(): { type: string; text: string } | null {
    const cch = configGet("safety.billing_cch");
    const ccVersion = configGet("safety.billing_cc_version");
    if (!cch || !ccVersion) {
        process.stderr.write(
            "LLM safety check: billing_cch and billing_cc_version must be configured.\n" +
                "  claude config set safety.billing_cch <value>\n" +
                "  claude config set safety.billing_cc_version <value>\n" +
                "Capture these values from Claude Code traffic via Proxyman.\n"
        );
        return null;
    }
    return {
        type: "text",
        text: `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=hook; cch=${cch};`,
    };
}

/** Result of a successful API call: the raw text plus usage metadata. */
export interface CallApiResult {
    text: string;
    usage: ApiUsage;
    /** Model name as reported by the API response. */
    model: string;
}

/**
 * Make a single Anthropic API call for a given classifier stage.
 * Returns text plus usage metadata on success, or null on error.
 */
export async function callApi(apiKey: string, stage: ClassifierStage, userMessage: string, model?: string): Promise<CallApiResult | null> {
    const billingBlock = buildBillingHeaderBlock();
    if (!billingBlock) return null;

    const safetyModel = model || configGet("safety.model", DEFAULT_SAFETY_MODEL) || DEFAULT_SAFETY_MODEL;
    const supportsThinking = /sonnet-4-[56]|opus-4-[56]/.test(safetyModel);

    const cacheControl = { type: "ephemeral" as const, ttl: "1h" as const };
    const userRules = configGetObject("safety.user_rules") as SafetyUserRules | undefined;
    const systemText = buildSystemPrompt(userRules);

    const config = STAGE_CONFIG[stage];
    const requestBody: Record<string, unknown> = {
        model: safetyModel,
        max_tokens: config.budget,
        system: [
            { ...billingBlock, cache_control: cacheControl },
            { type: "text", text: systemText, cache_control: cacheControl },
        ],
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: userMessage, cache_control: cacheControl }],
            },
        ],
    };
    if (config.useThinking && supportsThinking) {
        requestBody.thinking = { type: "adaptive" };
        const isOpus = /opus-4-[56]/.test(safetyModel);
        requestBody.output_config = { effort: isOpus ? "max" : "high" };
    }
    if (config.stopSequences) requestBody.stop_sequences = config.stopSequences;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAFETY_TIMEOUT_MS);

    const betaHeaders = [
        "claude-code-20250219",
        "context-1m-2025-08-07",
        "interleaved-thinking-2025-05-14",
        "redact-thinking-2026-02-12",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "advanced-tool-use-2025-11-20",
        "effort-2025-11-24",
    ];
    let resp: Response;
    try {
        resp = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": betaHeaders.join(","),
                "anthropic-dangerous-direct-browser-access": "true",
                "x-api-key": apiKey,
                "x-app": "cli",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`LLM safety check fetch error: ${msg.slice(0, 200)}\n`);
        return null;
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) {
        const errBody = await resp.text();
        process.stderr.write(`LLM safety check API error ${resp.status}: ${errBody.slice(0, 200)}\n`);
        return null;
    }

    const data = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: ApiUsage;
        model?: string;
    };
    let text: string | null = null;
    for (const block of data.content ?? []) {
        if (block.type === "text" && block.text) {
            text = block.text.trim();
            break;
        }
    }
    if (text === null) return null;
    // The API echoes the model used in the response. Fall back to whatever the
    // request asked for if for some reason the response omits it.
    const responseModel = typeof data.model === "string" ? data.model : safetyModel;
    const responseUsage: ApiUsage = data.usage ?? { input_tokens: 0, output_tokens: 0 };
    return { text, usage: responseUsage, model: responseModel };
}

function parseJsonVerdict(text: string): SafetyCheckResult | null {
    try {
        const cleaned = text
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleaned) as SafetyCheckResult;
    } catch {
        return null;
    }
}

/**
 * Run a single classifier call and parse its output for the given stage.
 *
 * If `usageOut` is provided, every successful API call pushes one
 * `{model, usage}` entry to it. The caller can later aggregate these to
 * report combined usage on the final SafetyCheckResult. Failed API calls
 * (callApi returned null) push nothing.
 */
export async function runStage(
    apiKey: string,
    stage: ClassifierStage,
    actionMessage: string,
    model?: string,
    usageOut?: ApiUsageEntry[]
): Promise<SafetyCheckResult | null> {
    const directive = buildStageDirective(stage);
    const fullMessage = `${actionMessage}\n\n${directive}`;
    const apiResult = await callApi(apiKey, stage, fullMessage, model);
    if (apiResult === null) return null;
    if (usageOut) usageOut.push({ model: apiResult.model, usage: apiResult.usage });
    const text = apiResult.text;

    if (stage === "s1" || stage === "single_fast") {
        const xml = parseXmlVerdict(text);
        if (xml.block === null) return null;
        if (stage === "s1") {
            // S1: "no" = approve clear; "yes" = escalate to S2 (sentinel reason)
            return xml.block === "no"
                ? { decision: "approve", reason: "Stage 1 cleared" }
                : { decision: "needs_context", reason: S1_ESCALATE_SENTINEL };
        }
        // single_fast: "yes" = deny; "no" = approve
        return xml.block === "yes"
            ? { decision: "deny", reason: xml.reason || "Single-stage fast classifier denied" }
            : { decision: "approve", reason: xml.reason || "Single-stage fast classifier approved" };
    }

    return parseJsonVerdict(text);
}

/** Two-stage classifier: S1 fast gate, then S2 on escalate. */
export async function runTwoStage(
    apiKey: string,
    actionMessage: string,
    model?: string,
    usageOut?: ApiUsageEntry[]
): Promise<SafetyCheckResult | null> {
    const s1 = await runStage(apiKey, "s1", actionMessage, model, usageOut);
    if (!s1) return null;
    if (s1.decision === "approve") return s1;
    if (s1.decision === "deny") return s1;
    // Anything else (including the S1_ESCALATE_SENTINEL) -> run S2
    return runStage(apiKey, "s2", actionMessage, model, usageOut);
}

/** Single-stage classifier (fast or thinking variant). */
export async function runSingleStage(
    apiKey: string,
    mode: "single_fast" | "single_thinking",
    actionMessage: string,
    model?: string,
    usageOut?: ApiUsageEntry[]
): Promise<SafetyCheckResult | null> {
    return runStage(apiKey, mode, actionMessage, model, usageOut);
}
