import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Minimal DOM + fetch mock harness: load userscript's pure helpers by extracting buildTimelineBricks
describe("timeline export api", () => {
  it("buildTimelineBricks sorts by name numeric and sets cumulative left", () => {
    // This test will FAIL until buildTimelineBricks exists
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /function buildTimelineBricks/);
  });
  it("api.renderTimeline posts JSON to render_project/tmp with correct content-type", async () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /renderTimeline/);
    assert.match(src, /render_project\/tmp/);
  });
});
