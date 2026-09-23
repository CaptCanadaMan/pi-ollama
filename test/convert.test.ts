import { describe, expect, it } from "vitest";
import { convertMessages, resolveContext } from "../src/convert.js";

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

describe("resolveContext — pi >= 0.86 transcript contract (issue #11)", () => {
	const read = { name: "read", description: "Read a file", parameters: { type: "object" } };
	const bash = { name: "bash", description: "Run a command", parameters: { type: "object" } };
	const user = { role: "user", content: "hi", timestamp: 1 };

	it("recovers tools and the system prompt from the leading system message", () => {
		const r = resolveContext({
			messages: [
				{ role: "system", content: "base", sections: { a: "<a/>" }, toolsAdded: [read, bash], timestamp: 0 },
				user,
			],
		});
		expect(r.systemPrompt).toBe("base\n\n<a/>");
		expect(r.tools.map((t) => t.name)).toEqual(["read", "bash"]);
		expect(r.messages).toEqual([user]);
	});

	it("replays later system messages: appended content, section patches, tool removals", () => {
		const r = resolveContext({
			messages: [
				{ role: "system", content: "base", sections: { a: "<a/>", b: "<b/>" }, toolsAdded: [read, bash], timestamp: 0 },
				user,
				{ role: "system", content: [{ type: "text", text: "more" }], sections: { a: null, b: "<b2/>" }, toolsRemoved: [{ name: "bash" }], timestamp: 2 },
			],
		});
		expect(r.systemPrompt).toBe("base\n\nmore\n\n<b2/>");
		expect(r.tools.map((t) => t.name)).toEqual(["read"]);
		expect(r.messages).toEqual([user]);
	});

	it("passes old-style contexts (pi < 0.86) through unchanged", () => {
		const r = resolveContext({ systemPrompt: "sys", tools: [read], messages: [user] });
		expect(r.systemPrompt).toBe("sys");
		expect(r.tools).toEqual([read]);
		expect(r.messages).toEqual([user]);
	});

	it("yields no system prompt and no tools for a bare transcript", () => {
		const r = resolveContext({ messages: [user] });
		expect(r.systemPrompt).toBeUndefined();
		expect(r.tools).toEqual([]);
	});
});
