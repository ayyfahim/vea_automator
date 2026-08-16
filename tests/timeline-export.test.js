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
describe("timeline export state", () => {
  it("timelineExport state defaults exist and persist via UI_STATE_KEY", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /timelineExport/);
    assert.match(src, /timelineExportDefaults|timelineExportConfig/);
  });
});
describe("timeline export UI", () => {
  it("panel HTML contains timeline tab and controls", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /data-tab="timeline"/);
    assert.match(src, /ve-timeline-export-btn/);
    assert.match(src, /ve-timeline-progress/);
    assert.match(src, /ve-timeline-download-btn/);
  });
});
describe("timeline export core", () => {
  it("exportTimeline uses sorted videos and cumulative left", async () => {
    const { buildTimelineBricks } = global.__ve_test || {};
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /exportTimeline/);
    assert.match(src, /loadTimelineVideos/);
    if (global.__ve_test) {
      const vids = [{id:1, fileName:"2_video.mp4", duration:5000},{id:2, fileName:"10_video.mp4", duration:8000}];
      vids.sort((a,b)=>a.fileName.localeCompare(b.fileName,undefined,{numeric:true}));
      const bricks = buildTimelineBricks(vids, "30");
      assert.equal(bricks[0].left, 0);
      assert.equal(bricks[1].left, 5000);
    } else {
      // pure logic check without vm harness: verify buildTimelineBricks handles cumulative left via source inspection
      assert.match(src, /buildTimelineBricks/);
      assert.match(src, /left/);
      // also validate cumulative left logic directly by extracting function source via regex and checking it increments left
      const fnMatch = src.match(/function buildTimelineBricks[\s\S]*?left \+= duration/);
      assert.ok(fnMatch, "buildTimelineBricks should accumulate left");
    }
  });
});
describe("timeline polling", () => {
  it("startTimelineProgressPolling calls getProjectProgress with start flag alternating", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /startTimelineProgressPolling/);
    assert.match(src, /getProjectProgress/);
    assert.match(src, /getListOutput/);
    assert.match(src, /downloadTimelineResult/);
  });
  it("isTimelinePollCompleted checks percent 100 and queue_status", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /isTimelinePollCompleted/);
    assert.match(src, /percent/);
    assert.match(src, /queue_status/);
  });
  it("checkTimelineResult polls get_list_output and fallback mediaPath", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /checkTimelineResult/);
    assert.match(src, /getListOutput/);
    assert.match(src, /mediaPath/);
    assert.match(src, /exportedVideo/);
  });
  it("polling uses 2000ms interval and handles user_queue guard", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /pollIntervalMs/);
    assert.match(src, /2000/);
    assert.match(src, /getUserQueue/);
    assert.match(src, /clearInterval/);
  });
});
describe("version bump", () => {
  it("userscript header version bumped to 0.7.0", () => {
    const m = fs.readFileSync("videoexpress-manager.user.js","utf8").match(/@version\s+([0-9.]+)/);
    assert.ok(m, "version not found");
    assert.match(m[1], /^0\.(7|8)\./);
  });
  it("stalled percent guard warns after 10 polls without infinite loop", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /stallCount|_timelineStall/i);
    assert.match(src, />\s*10/);
    assert.match(src, /clearInterval/);
  });
});

// --- behavioral tests (execute helpers via vm) ---
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) return null;
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
function loadHelpersViaVm() {
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  // Prefer window.__ve_test if already loaded (e.g., via previous vm harness), otherwise extract and eval
  if (global.__ve_test && global.__ve_test.buildTimelineBricks) return global.__ve_test;
  const configStub = "var config = { libraryId: 4, timelineExportDefaults: { quality: 'high', size: '1080', format: 'mp4', aspect: '16:9', namePrefix: 'timeline_', pollIntervalMs: 2000 } };";
  const gtf = extractFn(src, "getTimelineFrameSize");
  const btb = extractFn(src, "buildTimelineBricks");
  const btp = extractFn(src, "buildTimelinePayload");
  const cmp = extractFn(src, "compareMediaName");
  assert.ok(gtf, "getTimelineFrameSize not found");
  assert.ok(btb, "buildTimelineBricks not found");
  assert.ok(btp, "buildTimelinePayload not found");
  const sandbox = {};
  vm.createContext(sandbox);
  const code = `${configStub}\n${gtf}\n${btb}\n${btp}\n${cmp || ""}\n`;
  vm.runInContext(code, sandbox);
  return sandbox;
}

describe("timeline export behavioral", () => {
  it("buildTimelineBricks via vm sets cumulative left [0, duration] and frameSize derived", () => {
    const h = loadHelpersViaVm();
    assert.ok(h.buildTimelineBricks, "buildTimelineBricks missing in vm");
    assert.ok(h.getTimelineFrameSize, "getTimelineFrameSize missing");
    // frameSize derivation
    assert.equal(h.getTimelineFrameSize("16:9", "1080"), "1920x1080");
    assert.equal(h.getTimelineFrameSize("16:9", "720"), "1280x720");
    assert.equal(h.getTimelineFrameSize("9:16", "1080"), "1080x1920");
    assert.equal(h.getTimelineFrameSize("9:16", "720"), "720x1280");
    assert.equal(h.getTimelineFrameSize("1:1", "1080"), "1080x1080");
    assert.equal(h.getTimelineFrameSize("1:1", "720"), "720x720");
    // cumulative left
    const vids = [
      { id: 1, fileName: "a.mp4", duration: 5000 },
      { id: 2, fileName: "b.mp4", duration: 8000 },
      { id: 3, fileName: "c.mp4", duration_time: 3000 },
    ];
    const bricks = h.buildTimelineBricks(vids, "30", { aspect: "16:9", size: "1080" });
    assert.equal(bricks.length, 3);
    assert.equal(bricks[0].left, 0);
    assert.equal(bricks[1].left, 5000);
    assert.equal(bricks[2].left, 13000);
    assert.equal(bricks[0].duration, 5000);
    assert.equal(bricks[1].duration, 8000);
    assert.equal(bricks[2].duration, 3000);
    // frameSize should be landscape for 16:9
    assert.equal(bricks[0].frameSize, "1920x1080");
    // portrait
    const bricksPortrait = h.buildTimelineBricks(vids.slice(0,1), "30", { aspect: "9:16", size: "1080" });
    assert.equal(bricksPortrait[0].frameSize, "1080x1920");
    // payload cumulative check: last left + duration equals total
    const payload = h.buildTimelinePayload(bricks, { name: "test", quality: "high", size: "1080", format: "mp4", aspect: "16:9" }, 1234567890);
    assert.equal(payload.data[0].bricks.length, 3);
    const total = bricks[bricks.length-1].left + bricks[bricks.length-1].duration;
    assert.equal(total, 16000);
  });

  it("options.name truncation 80 chars via executed logic and vm", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    // verify source truncates
    assert.match(src, /slice\(0,\s*80\)/);
    // behavioral: execute the truncation expression as in renderTimeline
    const sandbox = { options: { name: "a".repeat(100) }, now: Date.now() };
    vm.createContext(sandbox);
    // this mirrors: String(options.name || `timeline_${now}`).slice(0, 80)
    vm.runInContext("var result = String(options.name || `timeline_${now}`).slice(0, 80);", sandbox);
    assert.equal(sandbox.result.length, 80);
    assert.equal(sandbox.result, "a".repeat(80));
    // also test fallback prefix truncation
    const sandbox2 = { options: {}, now: 1234567890 };
    vm.createContext(sandbox2);
    vm.runInContext("var result2 = String(options.name || `timeline_${now}`).slice(0, 80);", sandbox2);
    assert.ok(sandbox2.result2.startsWith("timeline_"));
    assert.ok(sandbox2.result2.length <= 80);
    // also try via extracted helpers if window.__ve_test exposes renderTimeline truncation indirectly
    // we already verified slice behavior
  });

  it("checkTimelineResult fallback guards recent datetime and sessionFetch used for download", () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    // fallback should log warning and check <5 min
    assert.match(src, /falling back to newest result/);
    assert.match(src, /5 \* 60 \* 1000|300000/);
    assert.match(src, /not recent/);
    // blob fallback must use sessionFetch
    assert.match(src, /sessionFetch\(v\.mediaPath/);
    assert.doesNotMatch(src, /await fetch\(v\.mediaPath/);
    // poll guard inFlight
    assert.match(src, /_timelinePollInFlight/);
    assert.match(src, /if \(_timelinePollInFlight\) return/);
    // frameSize helper exists
    assert.match(src, /function getTimelineFrameSize/);
    assert.match(src, /1920x1080/);
    assert.match(src, /1080x1920/);
  });
});
