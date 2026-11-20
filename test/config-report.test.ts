import { describe, expect, it, vi } from "vitest";
import { registerConfigReporting } from "../src/config-report.js";
import type { ConfigIssue } from "../src/model-config.js";

// Problems in the hand-edited config file are shown in pi when it starts
// (GH-14), so a typo is never a silently ignored setting.

type Handler = (event: { reason: string }, ctx: unknown) => Promise<void>;

function setup(issues: ConfigIssue[]) {
	let handler: Handler | undefined;
	registerConfigReporting({ on: (_event, h) => (handler = h as Handler) }, () => issues);
	const notify = vi.fn();
	return {
		notify,
		start: (reason = "startup", hasUI = true) => handler?.({ reason }, { hasUI, ui: { notify } }),
	};
}

const issues: ConfigIssue[] = [
	{ severity: "error", path: 'models["gemma4:12b"].warm', message: '= "yes" must be true or false - ignored' },
	{ severity: "warning", path: 'models["gemma4:12b"].colour', message: "is not a known setting - ignored" },
];

describe("config problems at startup", () => {
	it("shows each one in pi, errors as errors and warnings as warnings", async () => {
		const { notify, start } = setup(issues);

		await start();

		expect(notify.mock.calls).toEqual([
			['pi-ollama config: models["gemma4:12b"].warm = "yes" must be true or false - ignored', "error"],
			['pi-ollama config: models["gemma4:12b"].colour is not a known setting - ignored', "warning"],
		]);
	});

	it("says nothing when the file is fine", async () => {
		const { notify, start } = setup([]);
		await start();
		expect(notify).not.toHaveBeenCalled();
	});

	it("reports once, when pi starts, not on every new or resumed session", async () => {
		const { notify, start } = setup(issues);
		await start("new");
		await start("resume");
		expect(notify).not.toHaveBeenCalled();
	});

	it("writes to stderr when there is no UI to show it in", async () => {
		const { notify, start } = setup(issues.slice(0, 1));
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await start("startup", false);

		expect(notify).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledWith(
			'pi-ollama config: models["gemma4:12b"].warm = "yes" must be true or false - ignored\n',
		);
		write.mockRestore();
	});
});
