import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/session_\w+/;
const URL_LINE_RE = /"https:\/\/claude\.ai\/code\/session_\w+"/;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

export interface SessionWatchResult {
    sessionUrl: string;
    sessionId: string;
}

export interface SessionWatchOptions {
    workspace: string;
    timeoutMs?: number;
    expectedSessionId?: string;
}

export async function watchForSessionUrl(opts: SessionWatchOptions): Promise<SessionWatchResult> {
    const { workspace, timeoutMs = DEFAULT_TIMEOUT_MS, expectedSessionId } = opts;
    const projectDir = projectDirForWorkspace(workspace);
    await fs.mkdir(projectDir, { recursive: true });

    return new Promise<SessionWatchResult>((resolve, reject) => {
        let settled = false;
        const seen = new Map<string, number>();

        let pollHandle: ReturnType<typeof setInterval>;
        let timeoutHandle: ReturnType<typeof setTimeout>;

        const finish = (err: Error | null, ok?: SessionWatchResult) => {
            if (settled) return;
            settled = true;
            clearInterval(pollHandle);
            clearTimeout(timeoutHandle);
            try {
                watcher.close();
            } catch {
                // ignore
            }
            if (err) reject(err);
            else resolve(ok!);
        };

        const scanFile = async (filename: string): Promise<void> => {
            if (settled) return;
            if (!filename.endsWith(".jsonl")) return;
            if (expectedSessionId && filename !== `${expectedSessionId}.jsonl`) return;
            const full = path.join(projectDir, filename);
            try {
                const stat = await fs.stat(full);
                const lastByte = seen.get(filename) ?? 0;
                if (stat.size <= lastByte) return;
                const buf = await fs.readFile(full);
                seen.set(filename, buf.byteLength);
                const slice = buf.slice(lastByte).toString("utf8");
                const match = SESSION_URL_RE.exec(slice) ?? URL_LINE_RE.exec(slice);
                if (match) {
                    const sessionId = path.basename(filename, ".jsonl");
                    finish(null, { sessionUrl: stripQuotes(match[0]), sessionId });
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") finish(e as Error);
            }
        };

        const snapshotInitial = async (): Promise<void> => {
            const entries = await fs.readdir(projectDir).catch(() => [] as string[]);
            for (const f of entries) {
                if (!f.endsWith(".jsonl")) continue;
                try {
                    const stat = await fs.stat(path.join(projectDir, f));
                    seen.set(f, stat.size);
                } catch {
                    // ignore
                }
            }
        };

        const watcher = watch(projectDir, { persistent: true }, (_event, filename) => {
            if (filename) void scanFile(filename);
        });

        const pollAll = async (): Promise<void> => {
            const entries = await fs.readdir(projectDir).catch(() => [] as string[]);
            for (const f of entries) await scanFile(f);
        };

        void snapshotInitial();
        pollHandle = setInterval(() => void pollAll(), POLL_INTERVAL_MS);

        timeoutHandle = setTimeout(
            () => finish(new SessionWatchTimeoutError(workspace, timeoutMs, expectedSessionId)),
            timeoutMs,
        );
    });
}

function projectDirForWorkspace(workspace: string): string {
    const encoded = path.resolve(workspace).replace(/\//g, "-");
    return path.join(os.homedir(), ".claude", "projects", encoded);
}

function stripQuotes(s: string): string {
    return s.replace(/^"|"$/g, "");
}

export class SessionWatchTimeoutError extends Error {
    readonly workspace: string;
    readonly timeoutMs: number;
    readonly expectedSessionId?: string;
    constructor(workspace: string, timeoutMs: number, expectedSessionId?: string) {
        const what = expectedSessionId
            ? `Resumed session ${expectedSessionId} did not emit a remote-control URL`
            : `New session did not emit a remote-control URL`;
        super(`${what} within ${timeoutMs}ms in ${workspace}.`);
        this.name = "SessionWatchTimeoutError";
        this.workspace = workspace;
        this.timeoutMs = timeoutMs;
        this.expectedSessionId = expectedSessionId;
    }
}
