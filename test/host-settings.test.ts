import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHost } from "../src/host-settings.js";

const dirs: string[] = [];
function file(content?: string) {
 const dir = mkdtempSync(join(tmpdir(), "ollama-host-test-"));
 dirs.push(dir);
 const path = join(dir, "settings.json");
 if (content !== undefined) writeFileSync(path, content);
 return path;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
describe("host selection", () => {
 it("reads the existing extension's ollama.baseUrl", () => {
  expect(resolveHost("", file(JSON.stringify({ollama:{baseUrl:"http://192.168.2.222:11434"}})))).toBe("http://192.168.2.222:11434");
 });
 it("environment overrides even malformed settings", () => {
  expect(resolveHost("remote:11434", file("invalid"))).toBe("http://remote:11434");
 });
 it("defaults for missing files and unrelated settings", () => {
  expect(resolveHost("", file())).toBe("http://localhost:11434");
  expect(resolveHost("", file('{"ollama":{"baseUrl":42}}'))).toBe("http://localhost:11434");
 });
 it("ignores blank environment values", () => {
  expect(resolveHost("  ", file('{"ollama":{"baseUrl":"https://remote/proxy/v1/"}}'))).toBe("https://remote/proxy");
 });
 it("normalizes native API suffixes and IPv6", () => {
  expect(resolveHost("http://[::1]:11434/api/", file())).toBe("http://[::1]:11434");
 });
 it("reports malformed files rather than silently connecting elsewhere", () => {
  expect(() => resolveHost("", file("invalid"))).toThrow("Cannot read Ollama host");
 });
 it("rejects unsupported protocols and embedded credentials", () => {
  expect(() => resolveHost("ftp://remote", file())).toThrow("must use http");
  expect(() => resolveHost("https://user:pass@remote", file())).toThrow("credentials");
 });
});
