import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock getApiKey before importing the module under test
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, getApiKey: vi.fn(() => null) };
});

// Mock fs/promises for resolveRequestedFiles tests
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        stat: vi.fn(actual.stat as (...args: unknown[]) => unknown),
        readFile: vi.fn(actual.readFile as (...args: unknown[]) => unknown),
    };
});

import { stat, readFile } from "node:fs/promises";
import { checkCommandSafety, processHookInput, resolveRequestedFiles } from "../llm-safety-check.js";
import { getApiKey } from "../utils.js";

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

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

function mockApiResponse(decision: string, reason: string, files?: string[]) {
    const payload: Record<string, unknown> = { decision, reason };
    if (files) payload.files = files;
    return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
            content: [
                { type: "thinking", thinking: "..." },
                { type: "text", text: JSON.stringify(payload) },
            ],
        }),
    };
}

// ---------------------------------------------------------------------------
// resolveRequestedFiles
// ---------------------------------------------------------------------------

describe("resolveRequestedFiles", () => {
    it("reads files that exist", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('hello')" as never);

        const result = await resolveRequestedFiles(["/tmp/test_script.py"]);
        expect(result.get("/tmp/test_script.py")).toBe("print('hello')");
    });

    it("skips files that do not exist", async () => {
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        const result = await resolveRequestedFiles(["/tmp/nonexistent.py"]);
        expect(result.size).toBe(0);
    });

    it("skips files larger than the size limit", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100_000 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/huge_file.py"]);
        expect(result.size).toBe(0);
    });

    it("skips directories", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => false, size: 100 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/some_dir"]);
        expect(result.size).toBe(0);
    });

    it("reads multiple files", async () => {
        mockStat
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>)
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("script1" as never).mockResolvedValueOnce("script2" as never);

        const result = await resolveRequestedFiles(["/tmp/a.py", "/home/user/b.sh"]);
        expect(result.size).toBe(2);
        expect(result.get("/tmp/a.py")).toBe("script1");
        expect(result.get("/home/user/b.sh")).toBe("script2");
    });

    it("returns empty map for empty input", async () => {
        const result = await resolveRequestedFiles([]);
        expect(result.size).toBe(0);
    });
});

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
        const content = body.messages[0].content;
        expect(content).toContain("<untrusted-command>");
        expect(content).toContain("ls -la");
        expect(content).toContain("</untrusted-command>");
        expect(content).toContain("<untrusted-description>");
        expect(content).toContain("List files");
        expect(content).toContain("</untrusted-description>");
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

    it("performs two-pass when first call returns needs_context", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // Pass 1: model asks for file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need to inspect the script", ["/tmp/test.py"]));

        // File resolution
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('safe')" as never);

        // Pass 2: model makes final decision with file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Script is safe"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });

        expect(result).toEqual({ decision: "approve", reason: "Script is safe" });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Verify second call includes file contents
        const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        const content = secondBody.messages[0].content;
        expect(content).toContain("Referenced file contents (UNTRUSTED");
        expect(content).toContain('<untrusted-file path="/tmp/test.py">');
        expect(content).toContain("print('safe')");
    });

    it("handles needs_context with no files listed", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Ambiguous but no files to check"));

        const result = await checkCommandSafety("Bash", { command: "some-command" });

        // Should return the needs_context result as-is without a second call
        expect(result).toEqual({ decision: "needs_context", reason: "Ambiguous but no files to check" });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles needs_context when requested files don't exist", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // Pass 1: model asks for file
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/missing.py"]));

        // File doesn't exist
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        // Pass 2: model decides without file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Script not found on disk"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/missing.py" });

        expect(result).toEqual({ decision: "prompt", reason: "Script not found on disk" });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Second call should not include file contents section
        const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(secondBody.messages[0].content).not.toContain("Referenced file contents");
    });

    it("returns null when second pass API call fails", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/test.py"]));

        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("content" as never);

        // Second API call fails
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" });

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });
        expect(result).toBeNull();
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
