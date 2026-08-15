// test_retry_info.js — Task 1: getFailureReason (real impl)
const normalizeStatus = (v)=> String(v||"").toLowerCase();
function getFailureReason(record) {
  if (!record || typeof record !== "object") return "";
  const status = normalizeStatus(record.status);
  if (status !== "failed" && status !== "parallel_limit") return "";
  const candidates = [
    record.error,
    record.response && (record.response.error || record.response.message),
    record.statusPayload && (record.statusPayload.error || record.statusPayload.message || record.statusPayload.status),
    typeof record.response === "string" ? record.response : "",
    typeof record.statusPayload === "string" ? record.statusPayload : "",
  ].filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
  if (!candidates.length) return status === "parallel_limit" ? "Parallel limit — up to 5 AI videos in progress" : "Failed — no detail from server";
  let raw = candidates[0];
  raw = raw.replace(/^Generate video failed:\s*/i, "").replace(/^Status poll failed.*?:\s*/i, "").replace(/\n[\s\S]*$/, (m) => m.slice(0, 180));
  raw = raw.split("\n")[0].trim();
  if (raw.length > 180) raw = raw.slice(0, 177) + "...";
  return raw || (status === "parallel_limit" ? "Parallel limit" : "Failed");
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) { console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); process.exitCode = 1; }
  else console.log(`PASS ${label}`);
}
const cases = [
  [{ status:"failed", error:"Generate video failed: 429 Too Many Requests\nparallel limit" }, "429 Too Many Requests"],
  [{ status:"failed", response:{ error:"multiple videos in progress" } }, "multiple videos in progress"],
  [{ status:"failed", response:{ message:"up to 5 ai videos" } }, "up to 5 ai videos"],
  [{ status:"failed", statusPayload:{ status:"failed", message:"GPU overloaded" } }, "GPU overloaded"],
  [{ status:"failed", statusPayload:{ error:"internal error" } }, "internal error"],
  [{ status:"failed", error:"Error: something went wrong" }, "something went wrong"],
  [{ status:"completed" }, ""],
  [null, ""],
  [{ status:"parallel_limit", response:{ error:"parallel" } }, "parallel"],
];
for (const [rec, mustContain] of cases) {
  const got = getFailureReason(rec);
  if (mustContain === "") assertEqual(got, "", `empty for ${JSON.stringify(rec)}`);
  else if (!got.toLowerCase().includes(mustContain.toLowerCase())) { console.error(`FAIL should contain "${mustContain}" got "${got}"`); process.exitCode=1; }
  else console.log(`PASS contains "${mustContain}"`);
}
console.log("If all PASS, helper would be done — but stub returns empty so we expect FAILs");

// Extra invariants: trim ≤180, never throws, empty for non-failed
console.log("--- invariants ---");
const long = { status:"failed", error:"a".repeat(300) };
const gotLong = getFailureReason(long);
if (gotLong.length > 180) { console.error(`FAIL trim length ${gotLong.length} >180`); process.exitCode=1; } else console.log(`PASS trim length ${gotLong.length} <=180`);
assertEqual(getFailureReason({ status:"running", error:"oops"}), "", "non-failed returns empty");
assertEqual(getFailureReason({ status:"failed" }), "Failed — no detail from server", "failed no detail fallback");
assertEqual(getFailureReason({ status:"parallel_limit" }), "Parallel limit — up to 5 AI videos in progress", "parallel_limit no detail fallback");
try { getFailureReason(null); getFailureReason(undefined); getFailureReason("bad"); console.log("PASS never throws"); } catch(e) { console.error("FAIL throws", e); process.exitCode=1; }
if (!process.exitCode) console.log("ALL PASS");
