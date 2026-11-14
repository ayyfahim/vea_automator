const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync("videoexpress-manager.user.js", "utf8");

function extractFn(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(m, `function ${name} not found`);
  let i = src.indexOf("{", src.indexOf(")", m.index));
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error("unbalanced " + name);
}

function load(state) {
  const sandbox = { state };
  vm.createContext(sandbox);
  const code = ["getQueuePositionForMedia", "createSaveGate", "planQueueDownloads", "serialFileName", "nextRunSessionName"]
    .map(extractFn).join("\n");
  vm.runInContext(code, sandbox);
  return sandbox;
}

describe("run session names", () => {
  it("starts at 01 and takes the next free number for the same day", () => {
    const s = load({ folders: [] });
    assert.equal(s.nextRunSessionName("2026-11-20"), "2026-11-20-01");
    const s2 = load({ folders: [{ name: "2026-11-20-01" }, { title: "2026-11-20-02" }, { name: "2026-11-19-07" }, { name: "holiday" }] });
    assert.equal(s2.nextRunSessionName("2026-11-20"), "2026-11-20-03");
    assert.equal(s2.nextRunSessionName("2026-11-21"), "2026-11-21-01");
  });
});

describe("serial download names", () => {
  const rec = (n, started) => ({ folderId: 1, imageId: "m" + n, imageName: "img" + n, startedAt: started });

  it("uses queue positions, zero-padded, in order", () => {
    const state = { history: { records: {} }, queue: [], items: [], gen: {} };
    for (let n = 1; n <= 12; n++) state.queue.push({ media: { id: "m" + n } });
    const s = load(state);
    const recs = [12, 3, 10, 1, 2].map((n) => rec(n));
    const plan = s.planQueueDownloads(recs);
    assert.deepEqual(plan.map((p) => p.num), [1, 2, 3, 10, 12]);
    assert.equal(s.serialFileName(3, plan[0].width, "img3.mp4"), "003_img3.mp4");
  });

  it("falls back to rank by start time when the queue is not loaded", () => {
    const s = load({ history: { records: {} }, queue: [], items: [], gen: {} });
    const plan = s.planQueueDownloads([rec(2, "2026-11-20T10:05:00Z"), rec(1, "2026-11-20T10:00:00Z"), rec(3, "2026-11-20T10:09:00Z")]);
    assert.deepEqual(plan.map((p) => [p.rec.imageId, p.num]), [["m1", 1], ["m2", 2], ["m3", 3]]);
  });

  it("uses Generate line numbers and does not double the number", () => {
    const state = {
      history: { records: {} }, queue: [], items: [],
      gen: { run: { folderId: 1, items: [{ index: 0, image: { mediaId: "m1" } }, { index: 1, image: { mediaId: "m2" } }] } },
    };
    const s = load(state);
    const plan = s.planQueueDownloads([rec(2), rec(1)]);
    assert.deepEqual(plan.map((p) => p.num), [1, 2]);
    assert.equal(s.serialFileName(2, 3, "002 - a cat.mp4"), "002 - a cat.mp4");
  });
});

describe("save gate", () => {
  it("releases saves in order even when tasks finish out of order", async () => {
    const s = load({});
    const gate = s.createSaveGate();
    const saved = [];
    const task = async (i, delay, fail) => {
      try {
        await new Promise((r) => setTimeout(r, delay));
        if (fail) return;
        await gate.wait(i);
        saved.push(i);
      } finally {
        gate.finish(i);
      }
    };
    await Promise.all([task(0, 40), task(1, 5), task(2, 20, true), task(3, 1), task(4, 10)]);
    assert.deepEqual(saved, [0, 1, 3, 4]);
  });
});
