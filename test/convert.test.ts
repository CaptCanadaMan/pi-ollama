import { describe, expect, it } from "vitest";
import {
	collapseSystemMessages,
	convertContext,
	convertMessages,
	type PiContext,
	type PiMessage,
	toTranscript,
} from "../src/convert.js";

const B64 = "aGVsbG8="; // any base64 payload — conversion never decodes it

type Msgs = Parameters<typeof convertMessages>[0];

describe("convertMessages — images", () => {
	it("passes user-message images through on vision models", () => {
		const msgs = [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{ type: "image", data: B64, mediaType: "image/png" },
				],
			},
		] as unknown as Msgs;
		const wire = convertMessages(msgs, undefined, true);
		expect(wire).toHaveLength(1);
		expect(wire[0]!.images).toEqual([B64]);
	});

	it("passes tool-result images through on vision models (the camera-frame seam)", () => {
		const msgs = [
			{ role: "user", content: "take a photo" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "snap", arguments: {} }],
			},
			{
				role: "toolResult",
				toolName: "snap",
				toolCallId: "c1",
				content: [{ type: "image", data: B64, mediaType: "image/jpeg" }],
			},
		] as unknown as Msgs;
		const wire = convertMessages(msgs, undefined, true);
		const tool = wire.find((m) => m.role === "tool");
		expect(tool).toBeDefined();
		expect(tool!.images).toEqual([B64]);
		expect(tool!.content).toBe("(image result)");
		expect(tool!.tool_name).toBe("snap");
	});

	it("keeps tool-result text alongside its images", () => {
		const msgs = [
			{
				role: "toolResult",
				toolName: "snap",
				toolCallId: "c1",
				content: [
					{ type: "text", text: "captured at 12:00" },
					{ type: "image", data: B64 },
				],
			},
		] as unknown as Msgs;
		const wire = convertMessages(msgs, undefined, true);
		expect(wire[0]!.content).toBe("captured at 12:00");
		expect(wire[0]!.images).toEqual([B64]);
	});

	it("drops images (everywhere) when the model has no vision", () => {
		const msgs = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hi" },
					{ type: "image", data: B64 },
				],
			},
			{
				role: "toolResult",
				toolName: "snap",
				toolCallId: "c1",
				content: [{ type: "image", data: B64 }],
			},
		] as unknown as Msgs;
		const wire = convertMessages(msgs, undefined, false);
		for (const m of wire) expect(m.images).toBeUndefined();
		expect(wire.find((m) => m.role === "tool")!.content).toBe("(no result)");
	});
});

describe("convertMessages — normalisation", () => {
	it("strips aborted assistant turns and their orphaned tool results", () => {
		const msgs = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "toolCall", id: "c1", name: "snap", arguments: {} }],
			},
			{
				role: "toolResult",
				toolName: "snap",
				toolCallId: "c1",
				content: [{ type: "text", text: "orphan" }],
			},
			{ role: "user", content: "again" },
		] as unknown as Msgs;
		const wire = convertMessages(msgs, "sys", true);
		expect(wire.map((m) => m.role)).toEqual(["system", "user", "user"]);
	});
});

// gh#11 - replay cases adapted from TRex22's PR #12.
describe("collapseSystemMessages - the pi >= 0.86 transcript contract (gh#11)", () => {
	const read = { name: "read", description: "Read a file", parameters: { type: "object" } };
	const bash = { name: "bash", description: "Run a command", parameters: { type: "object" } };
	const user = { role: "user", content: "hi" };
	const collapse = (msgs: object[]) => collapseSystemMessages(msgs as unknown as PiMessage[]);

	it("takes the prompt and tools from the leading system message", () => {
		const r = collapse([
			{ role: "system", content: "base", sections: { a: "<a/>" }, toolsAdded: [read, bash] },
			user,
		]);
		expect(r.prompt).toBe("base\n\n<a/>");
		expect(r.tools.map((t) => t.name)).toEqual(["read", "bash"]);
		expect(r.messages).toEqual([user]);
	});

	it("replays later system messages: appended content, section patches, tool removals", () => {
		const r = collapse([
			{ role: "system", content: "base", sections: { a: "<a/>", b: "<b/>" }, toolsAdded: [read, bash] },
			user,
			{
				role: "system",
				content: [{ type: "text", text: "more" }],
				sections: { a: null, b: "<b2/>" },
				toolsRemoved: [{ name: "bash" }],
			},
		]);
		expect(r.prompt).toBe("base\n\nmore\n\n<b2/>");
		expect(r.tools.map((t) => t.name)).toEqual(["read"]);
		expect(r.messages).toEqual([user]);
	});

	it("keeps the last definition when a tool name is declared twice", () => {
		const read2 = { ...read, description: "Read a file, v2" };
		const r = collapse([{ role: "system", content: "", toolsAdded: [read, bash, read2] }]);
		expect(r.tools).toEqual([read2, bash]);
	});

	it("yields no prompt and no tools for a bare transcript", () => {
		const r = collapse([user]);
		expect(r.prompt).toBe("");
		expect(r.tools).toEqual([]);
		expect(r.messages).toEqual([user]);
	});
});

describe("toTranscript - pi < 0.86 folds into the same path", () => {
	const read = { name: "read", description: "Read a file", parameters: { type: "object" } };
	const user = { role: "user", content: "hi" };

	it("turns systemPrompt/tools into a leading system message", () => {
		const r = collapseSystemMessages(
			toTranscript({ systemPrompt: "sys", tools: [read], messages: [user] } as unknown as PiContext),
		);
		expect(r.prompt).toBe("sys");
		expect(r.tools).toEqual([read]);
		expect(r.messages).toEqual([user]);
	});

	it("passes a transcript without the old fields through untouched", () => {
		const messages = [user] as unknown as PiMessage[];
		expect(toTranscript({ messages })).toBe(messages);
	});

	it("composes the old fields with an injected system message instead of picking one", () => {
		const r = collapseSystemMessages(
			toTranscript({
				systemPrompt: "sys",
				tools: [read],
				messages: [user, { role: "system", content: "injected" }],
			} as unknown as PiContext),
		);
		expect(r.prompt).toBe("sys\n\ninjected");
		expect(r.tools).toEqual([read]);
	});
});

describe("convertContext", () => {
	it("still strips an orphaned tool result when a system message sits between it and its aborted turn", () => {
		const { messages } = convertContext(
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						stopReason: "aborted",
						content: [{ type: "toolCall", id: "c1", name: "snap", arguments: {} }],
					},
					{ role: "system", content: "", sections: { note: "<note/>" } },
					{
						role: "toolResult",
						toolName: "snap",
						toolCallId: "c1",
						content: [{ type: "text", text: "orphan" }],
					},
				],
			} as unknown as PiContext,
			true,
		);
		expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
	});
});
