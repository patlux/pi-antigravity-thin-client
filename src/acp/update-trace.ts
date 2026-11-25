import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpSessionUpdateNotification } from "./protocol.ts";

/**
 * Optional local trace of every `session/update` notification agy sends.
 *
 * `PI_AGY_TRACE=1` writes to `<tmpdir>/pi-agy-trace-<pid>.jsonl`; any other
 * non-empty value is used as the file path. Each line records the time, whether a
 * Pi turn was consuming updates (`piTurnActive`) and the full update. The trace
 * only reads what agy already sent; it never sends anything. It may contain
 * file contents and command output, so it stays on this machine.
 */
export class AcpUpdateTrace {
	private readonly filePath: string | undefined;
	private failed = false;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		const raw = env.PI_AGY_TRACE?.trim();
		if (!raw || raw === "0" || raw.toLowerCase() === "false") {
			this.filePath = undefined;
		} else if (raw === "1" || raw.toLowerCase() === "true") {
			this.filePath = path.join(os.tmpdir(), `pi-agy-trace-${process.pid}.jsonl`);
		} else {
			this.filePath = raw;
		}
	}

	get path(): string | undefined {
		return this.filePath;
	}

	record(notification: AcpSessionUpdateNotification, piTurnActive: boolean): void {
		if (!this.filePath || this.failed) return;
		const line = JSON.stringify({
			at: new Date().toISOString(),
			sessionId: notification.sessionId,
			sessionUpdate: notification.update.sessionUpdate,
			piTurnActive,
			update: notification.update,
		});
		try {
			fs.appendFileSync(this.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {
			// A broken trace path must never disturb the session; stop tracing instead.
			this.failed = true;
		}
	}
}
