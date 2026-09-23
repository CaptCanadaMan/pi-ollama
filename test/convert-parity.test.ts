import {
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	collapseSystemMessages,
	type PiContext,
	type PiMessage,
	toTranscript,
} from "../src/convert.js";

// convert.ts reimplements pi-ai's transcript replay instead of importing it,
// so the extension doesn't depend on the host's pi-ai version (gh#11). These
// check it against the real helpers from the pi-ai devDependency: a devDep
// bump fails here if upstream changes what the transcript means.

const tool = (name: string, description = name) => ({
	name,
	description,
	parameters: { type: "object" },
});
const user = { role: "user", content: "hi", timestamp: 1 };

const transcripts: Record<string, object[]> = {
	"prompt only": [{ role: "system", content: "base", timestamp: 0 }, user],
	"prompt, sections and tools": [
		{
			role: "system",
			content: "base",
			sections: { a: "<a/>", b: "<b/>" },
			toolsAdded: [tool("read"), tool("bash")],
			timestamp: 0,
		},
		user,
	],
	"later append, section patch and delete, removal": [
		{
			role: "system",
			content: "base",
			sections: { a: "<a/>", b: "<b/>" },
			toolsAdded: [tool("read"), tool("bash")],
			timestamp: 0,
		},
		user,
		{
			role: "system",
			content: [
				{ type: "text", text: "more" },
				{ type: "text", text: "lines" },
			],
			sections: { a: null, b: "<b2/>", c: "<c/>" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: 2,
		},
	],
	"tools only, empty content": [
		{ role: "system", content: "", toolsAdded: [tool("read")], timestamp: 0 },
		user,
	],
	"redefined and re-added tools": [
		{ role: "system", content: "base", toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
		{ role: "system", content: "", toolsAdded: [tool("read", "v2")], timestamp: 1 },
		{ role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 2 },
		{ role: "system", content: "", toolsAdded: [tool("bash", "v2")], timestamp: 3 },
	],
	"empty sections only": [
		{ role: "system", content: "", sections: { a: "" }, timestamp: 0 },
		user,
	],
	"no system messages": [user],
};

describe("collapseSystemMessages matches pi-ai's replay", () => {
	for (const [name, messages] of Object.entries(transcripts)) {
		it(name, () => {
			const ours = collapseSystemMessages(messages as unknown as PiMessage[]);
			const theirs = messages as Parameters<typeof getCurrentTools>[0];
			expect(ours.prompt).toBe(getCurrentSystemPrompt(theirs));
			expect(ours.tools).toEqual(getCurrentTools(theirs));
		});
	}
});

describe("toTranscript matches pi-ai's normalizeContext", () => {
	const contexts: Record<string, object> = {
		"prompt and tools": { systemPrompt: "sys", tools: [tool("read")], messages: [user] },
		"prompt only": { systemPrompt: "sys", messages: [user] },
		"tools only": { tools: [tool("read")], messages: [user] },
		"empty prompt, no tools": { systemPrompt: "", tools: [], messages: [user] },
		"legacy fields plus an injected system message": {
			systemPrompt: "sys",
			tools: [tool("read")],
			messages: [user, { role: "system", content: "injected", timestamp: 2 }],
		},
	};
	// normalizeContext stamps its synthetic message with timestamp 0; ours has none.
	const withoutTimestamps = (messages: readonly object[]) =>
		messages.map(({ timestamp: _, ...rest }: { timestamp?: number }) => rest);

	for (const [name, context] of Object.entries(contexts)) {
		it(name, () => {
			const ours = toTranscript(context as unknown as PiContext);
			const theirs = normalizeContext(context as Parameters<typeof normalizeContext>[0]);
			expect(withoutTimestamps(ours)).toEqual(withoutTimestamps(theirs.messages));
		});
	}
});
