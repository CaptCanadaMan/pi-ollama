import { describe, expect, it } from "vitest";
import { formatIssue, loadModelConfig, serverUrlFor } from "../src/model-config.js";

// Named servers in pi-ollama.json (GH-14, host rules from GH-16): a
// model can be pinned to an Ollama other than the default one. Hand-edited,
// so every address is checked before anything is sent to it.

describe("named servers", () => {
	it("reads servers and the models pinned to them", () => {
		const { config, issues } = loadModelConfig({
			servers: { jetson: { host: "10.0.0.5:11434" }, studio: { host: "https://studio.home/ollama" } },
			models: { "gemma4:12b": { server: "jetson" }, "muse-glimmer:30b": { server: "studio", warm: false } },
		});

		expect(issues).toEqual([]);
		expect(config.servers).toEqual({
			jetson: { baseUrl: "http://10.0.0.5:11434" },
			studio: { baseUrl: "https://studio.home/ollama" },
		});
		expect(serverUrlFor(config, "gemma4:12b")).toBe("http://10.0.0.5:11434");
		expect(serverUrlFor(config, "muse-glimmer:30b")).toBe("https://studio.home/ollama");
	});

	it("leaves a model with no server on the default one", () => {
		const { config } = loadModelConfig({
			servers: { jetson: { host: "10.0.0.5" } },
			models: { "gemma4:e4b": { warm: false } },
		});

		expect(serverUrlFor(config, "gemma4:e4b")).toBeUndefined();
		expect(serverUrlFor(config, "never-mentioned")).toBeUndefined();
		expect(serverUrlFor(undefined, "gemma4:e4b")).toBeUndefined();
	});

	it("fills in the scheme and Ollama's port when the host leaves them out", () => {
		const hosts = {
			bare: "jetson.local",
			withPort: "jetson.local:8080",
			withScheme: "http://jetson.local",
			https: "https://jetson.local",
			ipv6: "[::1]",
			trailingSlash: "http://jetson.local:11434/",
			proxyPath: "https://proxy.home/ollama/",
		};
		const { config, issues } = loadModelConfig({
			servers: Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, { host }])),
		});

		expect(issues).toEqual([]);
		expect(Object.fromEntries(Object.entries(config.servers).map(([n, s]) => [n, s.baseUrl]))).toEqual({
			bare: "http://jetson.local:11434",
			withPort: "http://jetson.local:8080",
			withScheme: "http://jetson.local",
			https: "https://jetson.local",
			ipv6: "http://[::1]:11434",
			trailingSlash: "http://jetson.local:11434",
			proxyPath: "https://proxy.home/ollama",
		});
	});

	it("rejects an address that could send requests somewhere unintended", () => {
		const { config, issues } = loadModelConfig({
			servers: {
				creds: { host: "https://andrew:secret@jetson.local" },
				query: { host: "http://jetson.local:11434?x=1" },
				fragment: { host: "http://jetson.local:11434#frag" },
				ftp: { host: "ftp://jetson.local" },
				spaces: { host: "jetson local" },
				empty: { host: "" },
				number: { host: 11434 },
				missing: {},
			},
		});

		expect(config.servers).toEqual({});
		expect(issues.map((i) => i.path)).toEqual([
			'servers["creds"].host',
			'servers["query"].host',
			'servers["fragment"].host',
			'servers["ftp"].host',
			'servers["spaces"].host',
			'servers["empty"].host',
			'servers["number"].host',
			'servers["missing"].host',
		]);
		expect(issues.every((i) => i.severity === "error")).toBe(true);
		// The password must not be echoed back into pi's UI or logs.
		expect(issues.map(formatIssue).join("\n")).not.toContain("secret");
		expect(formatIssue(issues[0]!)).toBe(
			'pi-ollama config: servers["creds"].host must not contain a username or password - server ignored',
		);
	});

	it("keeps a pinned model on the default server when its server isn't defined, and says so", () => {
		const { config, issues } = loadModelConfig({
			servers: { jetson: { host: "10.0.0.5" } },
			models: { "gemma4:12b": { server: "jetsen", warm: false }, "gemma4:e4b": { server: 5 } },
		});

		expect(serverUrlFor(config, "gemma4:12b")).toBeUndefined();
		expect(config.models["gemma4:12b"]).toEqual({ warm: false });
		expect(issues.map(formatIssue)).toEqual([
			'pi-ollama config: models["gemma4:12b"].server = "jetsen" is not one of the servers defined (jetson) - using the default server',
			'pi-ollama config: models["gemma4:e4b"].server = 5 must be the name of an entry in servers - ignored',
		]);
	});

	it("says there are no servers at all when a model names one", () => {
		const { issues } = loadModelConfig({ models: { "gemma4:12b": { server: "jetson" } } });

		expect(issues[0]?.message).toBe(
			'= "jetson" is not one of the servers defined (none are) - using the default server',
		);
	});

	it("warns about unknown keys in a server entry, and treats underscore keys as comments", () => {
		const { config, issues } = loadModelConfig({
			servers: { _note: "home lab", jetson: { host: "10.0.0.5", _why: "robot", apiKey: "sk-x" } },
		});

		expect(config.servers).toEqual({ jetson: { baseUrl: "http://10.0.0.5:11434" } });
		expect(issues).toEqual([
			{ severity: "warning", path: 'servers["jetson"].apiKey', message: "is not a known setting - ignored" },
		]);
	});

	it("rejects a servers block or entry that isn't an object", () => {
		expect(loadModelConfig({ servers: ["jetson"] }).issues[0]?.path).toBe("servers");
		expect(loadModelConfig({ servers: { jetson: "10.0.0.5" } }).issues[0]).toEqual({
			severity: "error",
			path: 'servers["jetson"]',
			message: '= "10.0.0.5" must be an object like { "host": "10.0.0.5:11434" } - ignored',
		});
	});
});
