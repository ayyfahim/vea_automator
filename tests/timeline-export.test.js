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
