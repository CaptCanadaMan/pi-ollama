// Shows config-file problems (model-config.ts) in pi when it starts, so a typo
// in a hand-edited setting is never just silently ignored (GH-14).

import { type ConfigIssue, formatIssue } from "./model-config.js";
import type { SessionStartPi } from "./session-start.js";

/**
 * Report once, at pi's own startup. With a UI the problems go through
 * ctx.ui.notify (errors show red); headless modes have no TUI to corrupt, so
 * they go to stderr.
 */
export function registerConfigReporting(pi: SessionStartPi, getIssues: () => ConfigIssue[]): void {
	pi.on?.("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		for (const issue of getIssues()) {
			if (ctx.hasUI === false) process.stderr.write(`${formatIssue(issue)}\n`);
			else ctx.ui.notify(formatIssue(issue), issue.severity);
		}
	});
}
