function getQueuePositionForMedia(mediaId) {
  const needle = String(mediaId);
  const q = Array.isArray(state.queue) ? state.queue : [];
  for (let i = 0; i < q.length; i++) {
    if (String(q[i] && q[i].media && q[i].media.id) === needle) return i + 1;
  }
  const items = Array.isArray(state.items) ? state.items : [];
  for (let i = 0; i < items.length; i++) {
    if (String(items[i] && items[i].id) === needle) return i + 1;
  }
  return null;
}
const state = {
  queue: [{media:{id:10}},{media:{id:20}},{media:{id:30}},{media:{id:40}}],
  items: [{id:10},{id:20},{id:30},{id:40},{id:50}]
};
function assertEq(actual, expected, label){
  if (actual !== expected) { console.error(`FAIL ${label} expected ${expected} got ${actual}`); process.exitCode=1; }
  else console.log(`PASS ${label}`);
}
assertEq(getQueuePositionForMedia(10), 1, "pos 10 -> 1");
assertEq(getQueuePositionForMedia(30), 3, "pos 30 -> 3");
assertEq(getQueuePositionForMedia(50), 5, "fallback to items 50 -> 5");
assertEq(getQueuePositionForMedia("20"), 2, "string id coercion 20 -> 2");
assertEq(getQueuePositionForMedia(999), null, "missing -> null");
assertEq(getQueuePositionForMedia("50"), 5, "string fallback 50 -> 5");
assertEq(getQueuePositionForMedia(40), 4, "pos 40 -> 4");
// edge: empty queue fallback
state.queue = [];
assertEq(getQueuePositionForMedia(10), 1, "empty queue fallback 10 -> 1 (items)");
state.queue = null;
assertEq(getQueuePositionForMedia(20), 2, "null queue fallback 20 -> 2");
// Task 2: prefixed naming — batch vs absolute (updated to pass with absolute queue pos)
state.queue = [{media:{id:10}},{media:{id:20}},{media:{id:30}},{media:{id:40}},{media:{id:50}}];
state.items = [{id:10},{id:20},{id:30},{id:40},{id:50}];
function buildPrefixedName(entry, myQIdx){
  const fake = {name: entry.rec.imageName, id: entry.rec.videoId};
  const raw = String(fake.name || fake.id).replace(/\.[a-z0-9]+$/i, "");
  const base = raw + ".mp4";
  const pos = getQueuePositionForMedia(entry.rec.imageId);
  const fallbackPos = myQIdx;
  const finalPos = pos != null ? pos : fallbackPos;
  return `${finalPos}_${base}`;
}
const entriesRemaining = [
  {rec:{imageId:40, imageName:"d.mp4", videoId:"9004"}},
  {rec:{imageId:50, imageName:"e.mp4", videoId:"9005"}}
];
const got0 = buildPrefixedName(entriesRemaining[0],1);
const got1 = buildPrefixedName(entriesRemaining[1],2);
if (got0 === "4_d.mp4" && got1 === "5_e.mp4") console.log("PASS absolute prefix");
else { console.error(`FAIL absolute prefix expected 4_d.mp4 got ${got0}, 5_e.mp4 got ${got1}`); process.exitCode=1; }
// fallback when queue not loaded
state.queue = [];
state.items = [];
function buildPrefixedNameFallback(entry, myQIdx){
  const base = String(entry.rec.imageName).replace(/\.[a-z0-9]+$/i,"") + ".mp4";
  const pos = getQueuePositionForMedia(entry.rec.imageId);
  const finalPos = pos != null ? pos : myQIdx;
  return `${finalPos}_${base}`;
}
const gotFallback = buildPrefixedNameFallback({rec:{imageId:99, imageName:"x.mp4", videoId:"1"}}, 1);
if (gotFallback === "1_x.mp4") console.log("PASS fallback prefix");
else { console.error(`FAIL fallback expected 1_x.mp4 got ${gotFallback}`); process.exitCode=1; }
// no pad check: pos 10 should be "10_" not "010_"
state.queue = Array.from({length:10}, (_,i)=>({media:{id: i+1}}));
state.items = Array.from({length:10}, (_,i)=>({id: i+1}));
const got10 = buildPrefixedName({rec:{imageId:10, imageName:"foo.mp4", videoId:"1"}}, 10);
if (got10 === "10_foo.mp4" && got10 !== "010_foo.mp4") console.log("PASS no pad 10_ not 010_");
else { console.error(`FAIL no pad expected 10_foo.mp4 got ${got10}`); process.exitCode=1; }
