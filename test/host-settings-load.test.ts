import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ loadPersistedConfig: () => ({}) }));
import { loadSettings } from "../src/settings.js";

let directory: string;
beforeEach(() => {
 directory = mkdtempSync(join(tmpdir(), "ollama-host-load-"));
 vi.stubEnv("PI_CODING_AGENT_DIR", directory);
 vi.stubEnv("OLLAMA_HOST", "");
 vi.stubEnv("OLLAMA_API_KEY", "");
 writeFileSync(join(directory, "settings.json"), JSON.stringify({
  ollama: {baseUrl: "https://ollama.example/proxy/v1/"},
 }));
});
afterEach(() => {
 vi.unstubAllEnvs();
 rmSync(directory, {recursive: true});
});

it("loads the host from the configured Pi agent directory", () => {
 expect(loadSettings().baseUrl).toBe("https://ollama.example/proxy");
});
it("keeps OLLAMA_HOST as the highest priority", () => {
 vi.stubEnv("OLLAMA_HOST", "other.example:11434");
 expect(loadSettings().baseUrl).toBe("http://other.example:11434");
});
it("does not send an unapproved API key to a settings-configured host", () => {
 vi.stubEnv("OLLAMA_API_KEY", "test-key-not-a-secret");
 const settings = loadSettings();
 expect(settings.apiKeyStatus).toBe("unapproved");
 expect(settings.apiKey).toBeUndefined();
});
