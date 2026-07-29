import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/convert.js";

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
