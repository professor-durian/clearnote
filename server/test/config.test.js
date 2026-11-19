import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-config-"));
process.env.CLEARNOTE_SETTINGS = path.join(dir, "settings.json");
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  delete process.env[k];
}
const config = await import("../config.js");
const { providerOrder } = await import("../ai.js");

test("settings are saved readable only by the owner", () => {
  config.update({ displayName: "Ada" });
  assert.equal(config.get("displayName"), "Ada");
  assert.equal(statSync(process.env.CLEARNOTE_SETTINGS).mode & 0o777, 0o600);
});

test("secrets are never returned, only whether they are set", () => {
  config.update({ anthropicKey: "sk-ant-secret-1234" });
  const view = config.publicView();
  assert.deepEqual(view.secrets.anthropicKey, { set: true, hint: "…1234" });
  assert.ok(!JSON.stringify(view).includes("secret-1234"));
  assert.ok(readFileSync(process.env.CLEARNOTE_SETTINGS, "utf8").includes("secret-1234"));
});

test("an empty value clears a secret", () => {
  config.update({ anthropicKey: "" });
  assert.equal(config.publicView().secrets.anthropicKey.set, false);
});

test("environment variables win and are reported as locked", () => {
  process.env.GOOGLE_CLIENT_ID = "from-env";
  config.update({ googleClientId: "from-file" });
  assert.equal(config.get("googleClientId"), "from-env");
  assert.ok(config.publicView().locked.includes("googleClientId"));
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal(config.get("googleClientId"), "from-file");
});

test("booleans and unknown keys are handled", () => {
  config.update({ autoCapture: "false", notASetting: "x" });
  assert.equal(config.get("autoCapture"), false);
  assert.equal("notASetting" in config.publicView().values, false);
});

test("provider order: primary first, backup only when allowed", () => {
  config.update({ anthropicKey: "", openrouterKey: "" });
  assert.deepEqual(providerOrder(), []);
  config.update({ openrouterKey: "sk-or-1", aiPrimary: "anthropic" });
  assert.deepEqual(providerOrder(), ["openrouter"], "the only configured provider is used even if not primary");
  config.update({ anthropicKey: "sk-ant-1", aiBackup: true });
  assert.deepEqual(providerOrder(), ["anthropic", "openrouter"]);
  config.update({ aiPrimary: "openrouter" });
  assert.deepEqual(providerOrder(), ["openrouter", "anthropic"]);
  config.update({ aiBackup: false });
  assert.deepEqual(providerOrder(), ["openrouter"]);
});
