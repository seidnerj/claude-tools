import { describe, it, expect } from "vitest";
import { parseChangelog, getVersion } from "../changelog.js";

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
