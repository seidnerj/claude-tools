import { describe, it, expect, vi, afterEach } from "vitest";
import { parseChangelog, getVersion, diffVersions, searchChangelog, fetchChangelog, compareSemver } from "../changelog.js";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

## 2.1.111

- Claude Opus 4.7 xhigh is now available! Use /effort to tune speed vs. intelligence
- Added \`OTEL_LOG_RAW_API_BODIES\` environment variable to emit full API request bodies
- Fixed terminal display tearing in iTerm2 + tmux setups
- Improved plugin error handling: dependency errors now distinguish conflicting requirements
- Changed \`Ctrl+O\` to toggle between normal and verbose transcript only
- Removed the deprecated \`--legacy\` flag
- Windows: PowerShell tool is progressively rolling out

## 2.1.110

- Added \`/tui\` command and \`tui\` setting for flicker-free rendering
- Fixed MCP tool calls hanging when server connection drops mid-response
- Improved \`/doctor\` to warn when an MCP server is defined in multiple scopes
- Security: Hardened "Open in editor" actions against command injection

## 2.1.109

- Improved the extended-thinking indicator with a rotating progress hint

## 2.1.107

- Show thinking hints sooner during long operations
`;

// ---------------------------------------------------------------------------
// parseChangelog
// ---------------------------------------------------------------------------

describe("parseChangelog", () => {
    it("extracts all versions from the changelog", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        expect(result.versions).toHaveLength(4);
        expect(result.versions.map((v) => v.version)).toEqual(["2.1.111", "2.1.110", "2.1.109", "2.1.107"]);
    });

    it("extracts entries for a version", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        const v111 = result.versions[0];
        expect(v111.entries).toHaveLength(7);
        expect(v111.entries[0].text).toBe("Claude Opus 4.7 xhigh is now available! Use /effort to tune speed vs. intelligence");
    });

    it("categorizes entries by leading verb", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        const v111 = result.versions[0];
        expect(v111.entries[0].category).toBe("Other");
        expect(v111.entries[1].category).toBe("Added");
        expect(v111.entries[2].category).toBe("Fixed");
        expect(v111.entries[3].category).toBe("Improved");
        expect(v111.entries[4].category).toBe("Changed");
        expect(v111.entries[5].category).toBe("Removed");
        expect(v111.entries[6].category).toBe("Other");
    });

    it("detects Security category from prefix", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        const v110 = result.versions[1];
        const securityEntry = v110.entries.find((e) => e.category === "Security");
        expect(securityEntry).toBeDefined();
        expect(securityEntry!.text).toContain("Hardened");
    });

    it("handles single-entry versions", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        const v109 = result.versions[2];
        expect(v109.entries).toHaveLength(1);
        expect(v109.entries[0].category).toBe("Improved");
    });

    it("handles versions where entry has no recognized category verb", () => {
        const result = parseChangelog(SAMPLE_CHANGELOG);
        const v107 = result.versions[3];
        expect(v107.entries).toHaveLength(1);
        expect(v107.entries[0].category).toBe("Other");
    });

    it("handles empty input", () => {
        const result = parseChangelog("");
        expect(result.versions).toHaveLength(0);
    });

    it("handles changelog with no version headers", () => {
        const result = parseChangelog("# Just a title\n\nSome text without versions.\n");
        expect(result.versions).toHaveLength(0);
    });

    it("handles version with no entries", () => {
        const result = parseChangelog("## 1.0.0\n\n## 0.9.0\n\n- First release\n");
        expect(result.versions).toHaveLength(2);
        expect(result.versions[0].entries).toHaveLength(0);
        expect(result.versions[1].entries).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

describe("getVersion", () => {
    const changelog = parseChangelog(SAMPLE_CHANGELOG);

    it("returns entries for an existing version", () => {
        const result = getVersion(changelog, "2.1.110");
        expect(result).not.toBeNull();
        expect(result!.version).toBe("2.1.110");
        expect(result!.entries).toHaveLength(4);
    });

    it("returns null for a non-existent version", () => {
        const result = getVersion(changelog, "9.9.9");
        expect(result).toBeNull();
    });

    it("matches version string exactly", () => {
        const result = getVersion(changelog, "2.1.11");
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// diffVersions
// ---------------------------------------------------------------------------

describe("diffVersions", () => {
    const changelog = parseChangelog(SAMPLE_CHANGELOG);

    it("returns versions between fromVersion (exclusive) and toVersion (inclusive)", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.109", toVersion: "2.1.111" });
        expect(result.fromVersion).toBe("2.1.109");
        expect(result.toVersion).toBe("2.1.111");
        expect(result.versions.map((v) => v.version)).toEqual(["2.1.110", "2.1.111"]);
    });

    it("orders versions oldest to newest", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.107", toVersion: "2.1.111" });
        const versions = result.versions.map((v) => v.version);
        expect(versions).toEqual(["2.1.109", "2.1.110", "2.1.111"]);
    });

    it("builds merged categories", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.109", toVersion: "2.1.111" });
        expect(result.merged["Added"]).toBeDefined();
        expect(result.merged["Fixed"]).toBeDefined();
        const allAdded = result.merged["Added"];
        expect(allAdded.length).toBeGreaterThan(0);
    });

    it("treats omitted toVersion as latest", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.110" });
        expect(result.toVersion).toBe("2.1.111");
        expect(result.versions.map((v) => v.version)).toEqual(["2.1.111"]);
    });

    it("treats omitted fromVersion as everything up to toVersion", () => {
        const result = diffVersions(changelog, { toVersion: "2.1.109" });
        expect(result.fromVersion).toBe("");
        expect(result.versions.map((v) => v.version)).toEqual(["2.1.107", "2.1.109"]);
    });

    it("returns all versions when no options provided", () => {
        const result = diffVersions(changelog);
        expect(result.versions).toHaveLength(4);
        expect(result.versions[0].version).toBe("2.1.107");
        expect(result.versions[3].version).toBe("2.1.111");
    });

    it("throws when fromVersion is not found", () => {
        expect(() => diffVersions(changelog, { fromVersion: "9.9.9" })).toThrow("not found");
    });

    it("throws when toVersion is not found", () => {
        expect(() => diffVersions(changelog, { toVersion: "9.9.9" })).toThrow("not found");
    });

    it("returns empty when fromVersion equals toVersion", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.110", toVersion: "2.1.110" });
        expect(result.versions).toHaveLength(0);
    });

    it("handles reversed version order by swapping them", () => {
        const result = diffVersions(changelog, { fromVersion: "2.1.111", toVersion: "2.1.109" });
        expect(result.fromVersion).toBe("2.1.109");
        expect(result.toVersion).toBe("2.1.111");
        expect(result.versions.map((v) => v.version)).toEqual(["2.1.110", "2.1.111"]);
    });
});

// ---------------------------------------------------------------------------
// searchChangelog
// ---------------------------------------------------------------------------

describe("searchChangelog", () => {
    const changelog = parseChangelog(SAMPLE_CHANGELOG);

    it("finds entries matching a substring (case-insensitive)", () => {
        const result = searchChangelog(changelog, "mcp");
        expect(result.query).toBe("mcp");
        expect(result.hits.length).toBeGreaterThan(0);
        expect(result.hits.every((h) => h.text.toLowerCase().includes("mcp"))).toBe(true);
    });

    it("returns version and category for each hit", () => {
        const result = searchChangelog(changelog, "plugin");
        expect(result.hits.length).toBeGreaterThan(0);
        for (const hit of result.hits) {
            expect(hit.version).toBeTruthy();
            expect(hit.category).toBeTruthy();
            expect(hit.text).toBeTruthy();
        }
    });

    it("returns empty hits when nothing matches", () => {
        const result = searchChangelog(changelog, "xyznonexistent");
        expect(result.hits).toHaveLength(0);
    });

    it("supports regex search", () => {
        const result = searchChangelog(changelog, "Ctrl\\+[A-Z]", { regex: true });
        expect(result.hits.length).toBeGreaterThan(0);
    });

    it("handles invalid regex gracefully by treating it as literal", () => {
        const result = searchChangelog(changelog, "[invalid(regex", { regex: true });
        expect(result.hits).toHaveLength(0);
    });

    it("matches across multiple versions", () => {
        const result = searchChangelog(changelog, "improved");
        const versions = new Set(result.hits.map((h) => h.version));
        expect(versions.size).toBeGreaterThan(1);
    });
});

// ---------------------------------------------------------------------------
// fetchChangelog
// ---------------------------------------------------------------------------

describe("fetchChangelog", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches and parses the changelog from GitHub", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(SAMPLE_CHANGELOG) }));
        const result = await fetchChangelog();
        expect(result.versions).toHaveLength(4);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws on HTTP error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
        await expect(fetchChangelog()).rejects.toThrow("Failed to fetch changelog");
    });

    it("throws on network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")));
        await expect(fetchChangelog()).rejects.toThrow("Network unreachable");
    });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe("compareSemver", () => {
    it("returns 0 for equal versions", () => {
        expect(compareSemver("2.1.110", "2.1.110")).toBe(0);
    });

    it("returns negative when a < b", () => {
        expect(compareSemver("2.1.109", "2.1.110")).toBeLessThan(0);
    });

    it("returns positive when a > b", () => {
        expect(compareSemver("2.1.111", "2.1.110")).toBeGreaterThan(0);
    });

    it("compares major versions", () => {
        expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
    });

    it("compares minor versions", () => {
        expect(compareSemver("2.0.0", "2.1.0")).toBeLessThan(0);
    });

    it("handles different segment lengths", () => {
        expect(compareSemver("2.1", "2.1.0")).toBe(0);
        expect(compareSemver("2.1", "2.1.1")).toBeLessThan(0);
    });
});
