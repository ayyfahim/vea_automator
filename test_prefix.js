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
