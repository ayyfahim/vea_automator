import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function extractFn(src, name){
  // try function declaration
  const fnStart = src.indexOf(`function ${name}`);
  if(fnStart!==-1){
    let depth=0, started=false;
    for(let i=fnStart;i<src.length;i++){
      const ch=src[i];
      if(ch==="{"){depth++; started=true;}
      else if(ch==="}"){depth--; if(started&&depth===0) return src.slice(fnStart,i+1);}
    }
  }
  // try const/let/var assignment (arrow or function expression)
  const patterns = [`const ${name} =`, `let ${name} =`, `var ${name} =`, `const ${name}=`, `let ${name}=`];
  for(const pat of patterns){
    const p = src.indexOf(pat);
    if(p===-1) continue;
    // find opening brace of function body
    let brace = src.indexOf("{", p);
    if(brace===-1) continue;
    // handle arrow with block: need to capture from assignment start to matching closing brace + optional semicolon
    let depth=0, started=false, end=-1;
    for(let i=brace;i<src.length;i++){
      const ch=src[i];
      if(ch==="{"){depth++; started=true;}
      else if(ch==="}"){depth--; if(started&&depth===0){ end=i+1; break; }}
    }
    if(end!==-1){
      let snippet = src.slice(p, end);
      // normalize const/let to var so it becomes property of sandbox global (vm const is lexical)
      snippet = snippet.replace(/^const\s+/, "var ").replace(/^let\s+/, "var ").replace(/\nconst\s+/g, "\nvar ").replace(/\nlet\s+/g, "\nvar ");
      // also handle case where pattern at start of snippet without newline
      if(snippet.startsWith("const ")) snippet = "var " + snippet.slice(6);
      if(snippet.startsWith("let ")) snippet = "var " + snippet.slice(4);
      return snippet;
    }
  }
  return null;
}
function loadHelpers(){
  const src=fs.readFileSync("videoexpress-manager.user.js","utf8");
  const stubs = `var config={libraryId:4, pageSize:100, videoLength:10, aspect:"16:9", delayBetweenRequestsMs:1500, parallelLimitRetryDelayMs:60000, maxParallelLimitRetries:Infinity, promptCleaner:{stripExtension:true, replaceUnderscores:true, replaceDashes:true, removeNumbers:false, collapseWhitespace:true}, masterPrompt:"", masterPromptEnabled:false, appendFilenamePrompt:false, promptListEnabled:false, promptList:"", timelineExportDefaults:{quality:"high",size:"1080",format:"mp4",aspect:"16:9",namePrefix:"timeline_",pollIntervalMs:2000}}; var state={history:{records:{}}, folders:[]};`;
  const names=["cleanPrompt","composePrompt","parsePromptList","normalizeStatus","isParallelLimitMessage","getFailureReason","extractVideoIdFromStatus","makeRecordKey","formatBytes","formatDuration","formatDateTime","sanitizeFileName","buildQueue","getQueueDownloadCounts","getTimelineFrameSize","buildTimelineBricks","buildTimelinePayload","compareMediaName"];
  let code=stubs+"\n";
  for(const n of names){ const fn=extractFn(src,n); if(fn) code+=fn+"\n"; }
  // also include getRecord/setRecord stubs if needed for buildQueue
  code+=`function getRecord(fid,mid){return state.history.records[\`library:\${config.libraryId}:folder:\${fid}:media:\${mid}\`]||null;} function setRecord(fid,mid,v){state.history.records[\`library:\${config.libraryId}:folder:\${fid}:media:\${mid}\`]=v;}`;
  const sandbox={}; vm.createContext(sandbox); vm.runInContext(code, sandbox); return {sandbox, src};
}

describe("pure helpers", ()=>{
  it("cleanPrompt strips extension, underscores/dashes, collapses, keeps numbers", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.match(s.cleanPrompt("001_warm-light_on_wood_table.jpg"), /warm light on wood table/);
    assert.equal(s.cleanPrompt("IMG_2026-08-16 (1).png"), "IMG 2026 08 16");
    assert.equal(s.cleanPrompt(""), "");
  });
  it("composePrompt respects masterPromptEnabled and {{image}}", ()=>{
    const {sandbox: s, src}=loadHelpers();
    // toggle
    vm.runInContext("config.masterPromptEnabled=false; config.masterPrompt='MASTER {{image}}';", s);
    assert.equal(s.composePrompt("hello"), "hello");
    vm.runInContext("config.masterPromptEnabled=true; config.masterPrompt='MASTER {{image}}'; config.appendFilenamePrompt=true;", s);
    assert.equal(s.composePrompt("hello"), "MASTER hello");
    vm.runInContext("config.masterPrompt='MASTER'; config.appendFilenamePrompt=true;", s);
    assert.equal(s.composePrompt("hello"), "MASTER, hello");
  });
  it("parsePromptList strips bullets and numbering", ()=>{
    const {sandbox: s}=loadHelpers();
    const v=s.parsePromptList(" - hello\n1) world\n 2. foo \n\nbar");
    assert.deepEqual([...v], ["hello","world","foo","bar"]);
  });
  it("normalizeStatus lowercases", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.equal(s.normalizeStatus("Completed"), "completed");
    assert.equal(s.normalizeStatus(""), "");
  });
  it("isParallelLimitMessage matches 5-parallel heuristics", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.ok(s.isParallelLimitMessage("multiple videos in progress"));
    assert.ok(s.isParallelLimitMessage("up to 5 ai videos in progress"));
    assert.ok(s.isParallelLimitMessage("Parallel limit"));
    assert.equal(s.isParallelLimitMessage("something else"), false);
  });
  it("extractVideoIdFromStatus probes 16+ paths", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.equal(s.extractVideoIdFromStatus({videoId: 123}), "123");
    assert.equal(s.extractVideoIdFromStatus({data:{id: 456}}), "456");
    assert.equal(s.extractVideoIdFromStatus({result:{videoId: 789}}), "789");
    assert.equal(s.extractVideoIdFromStatus({}), null);
  });
  it("formatBytes / formatDuration / formatDateTime smoke", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.match(s.formatBytes(500), /B/);
    assert.match(s.formatBytes(2048), /KB/);
    assert.equal(s.formatDuration(61000), "1:01");
    assert.equal(s.formatDuration(0), "-");
    assert.ok(s.formatDateTime(new Date().toISOString()).length>0);
  });
});

describe("queue + timeline pure", ()=>{
  it("buildQueue maps media to prompt and skip logic", ()=>{
    const {sandbox: s}=loadHelpers();
    vm.runInContext("config.promptListEnabled=false; config.skipStartedWithoutUuid=true; config.masterPromptEnabled=false;", s);
    const folder={id:"1"}; const items=[{id:"10", name:"hello_world.jpg", uuid:"u1", isPending:false}, {id:"11", name:"foo.jpg"}];
    s.state.history.records={}; s.state.history.records["library:4:folder:1:media:10"]={status:"completed"};
    const q=s.buildQueue(folder, items);
    assert.equal(q[0].skip, true); // completed skipped
    assert.equal(q[1].skip, false);
    assert.match(q[1].prompt, /hello world|foo/);
  });
  it("getTimelineFrameSize and buildTimelineBricks cumulative left", ()=>{
    const {sandbox: s}=loadHelpers();
    assert.equal(s.getTimelineFrameSize("16:9","1080"), "1920x1080");
    const bricks=s.buildTimelineBricks([{id:1,fileName:"a.mp4",duration:5000},{id:2,fileName:"b.mp4",duration:8000}],"30",{aspect:"16:9",size:"1080"});
    assert.equal(bricks[0].left,0); assert.equal(bricks[1].left,5000);
  });
});

describe("DOM contract (source-string, pre-wire)", ()=>{
  it("userscript header version exists", ()=>{
    const src=fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /@version\s+0\.8\.(3|4)/);
  });
  it("template contains required IDs (folders/upload/queue/downloads/timeline/activity)", ()=>{
    const src=fs.readFileSync("videoexpress-manager.user.js","utf8");
    for(const id of ["ve-folder-select","ve-upload-folder-select","ve-download-folder-select","ve-timeline-folder-select","ve-folder-grid","ve-refresh-btn","ve-file-input","ve-folder-input","ve-pick-files-btn","ve-pick-folder-btn","ve-upload-btn","ve-upload-summary","ve-video-length","ve-aspect","ve-delay-input","ve-retry-delay-input","ve-master-prompt-enabled","ve-prompt-list-enabled","ve-load-media-btn","ve-run-btn","ve-stop-btn","ve-queue-body","ve-stat-images","ve-stat-queued","ve-stat-running","ve-stat-done","ve-stat-failed","ve-folder-summary","ve-queue-download-summary","ve-queue-download-progress","ve-download-completed-btn","ve-download-remaining-btn","ve-retry-all-failed-btn","ve-video-body","ve-video-master-checkbox","ve-video-filter-query","ve-timeline-load-btn","ve-timeline-export-btn","ve-timeline-progress","ve-log"]){
      assert.match(src, new RegExp(id), `missing ${id}`);
    }
  });
  it("api routes present", ()=>{
    const src=fs.readFileSync("videoexpress-manager.user.js","utf8");
    for(const p of ["get_categories","add_category","delete_category","get_media","upload","image2video","status","render_project/tmp","project/progress","user_queue","get_list_output"]){
      assert.match(src, new RegExp(p.replace("/", "\\/")));
    }
  });
  it("els maps every expected selector and tabs present", ()=>{
    const src=fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /data-tab="folders"|data-tab="library"/);
    assert.match(src, /ve-tab|ve-step/);
    assert.match(src, /els\s*=\s*\{/);
  });
});
