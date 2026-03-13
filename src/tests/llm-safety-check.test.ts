import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock getApiKey before importing the module under test
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, getApiKey: vi.fn(() => null) };
});

import { checkCommandSafety, processHookInput } from "../llm-safety-check.js";
import { getApiKey } from "../utils.js";

const mockGetApiKey = vi.mocked(getApiKey);

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockGetApiKey.mockReturnValue(null);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper to create a mock Claude API response
// ---------------------------------------------------------------------------

function mockApiResponse(decision: string, reason: string) {
    return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
            content: [
                { type: "thinking", thinking: "..." },
                { type: "text", text: JSON.stringify({ decision, reason }) },
            ],
        }),
    };
}

// ---------------------------------------------------------------------------
// checkCommandSafety
// ---------------------------------------------------------------------------

describe("checkCommandSafety", () => {
    it("returns null when no API key is available", async () => {
        mockGetApiKey.mockReturnValue(null);

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns approve decision from API", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Safe read-only command"));

        const result = await checkCommandSafety("Bash", { command: "ls -la", description: "List files" });
        expect(result).toEqual({ decision: "approve", reason: "Safe read-only command" });

        // Verify the API was called with correct params
        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(opts.headers["x-api-key"]).toBe("test-key");

        const body = JSON.parse(opts.body);
        expect(body.model).toBe("claude-opus-4-6");
        expect(body.thinking).toEqual({ type: "adaptive" });
        expect(body.messages[0].content).toContain("ls -la");
    });

    it("returns deny decision from API", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous command"));

        const result = await checkCommandSafety("Bash", { command: "rm -rf /" });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous command" });
    });

    it("returns null on API error", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal Server Error" });

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns null on network failure", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockRejectedValueOnce(new Error("Network unreachable"));

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("handles markdown-wrapped JSON response", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: "text", text: '```json\n{"decision": "prompt", "reason": "Ambiguous"}\n```' }],
            }),
        });

        const result = await checkCommandSafety("Bash", { command: "curl example.com" });
        expect(result).toEqual({ decision: "prompt", reason: "Ambiguous" });
    });
});

// ---------------------------------------------------------------------------
// processHookInput
// ---------------------------------------------------------------------------

describe("processHookInput", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
    });

    it("returns allow output for approve decision", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Safe command"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "git status" },
        });
        expect(result).toEqual({ decision: "allow", reason: "Safe command" });
    });

    it("returns deny output for deny decision", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "rm -rf /" },
        });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous" });
    });

    it("returns null for prompt decision (fall through)", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Ambiguous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });
        expect(result).toBeNull();
    });

    it("logs reason to stderr for prompt decision", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Contains hardcoded credentials"));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl -u user:pass example.com" },
        });

        expect(stderrSpy).toHaveBeenCalledWith("LLM safety check [prompt]: Contains hardcoded credentials\n");
        stderrSpy.mockRestore();
    });

    it("does not log to stderr for prompt decision with empty reason", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", ""));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });

        expect(stderrSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
    });

    it("returns null on API failure (fall through)", async () => {
        mockFetch.mockRejectedValueOnce(new Error("timeout"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "ls" },
        });
        expect(result).toBeNull();
    });
});
