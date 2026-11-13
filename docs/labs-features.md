# "Try new features" mode (v0.10.0)

The header now has a version dropdown next to the palette picker:

- **Stable version** (default): the manager behaves as it did in 0.9.7.
- **Try new features**: turns on everything listed below. The choice is saved as `versionMode` in `videoexpress.manager.ui-state.v1`.

The dropdown is locked while a queue, download, upload, Generate run or timeline export is running, so one run never mixes old and new behaviour. In the code every change checks `labsOn()` (or `config.labsEnabled` in the two functions the unit tests run on their own: `buildQueue` and `getFailureReason`).

## Fixes for broken logic

| # | Problem in Stable | What labs mode does |
|---|---|---|
| 1 | Downloads and the Generate queue share one Pause flag. Pausing downloads stops the queue and the other way round. The flag also stays set after a Pause, so later folder loads stop after the first page (Collect shows only 100 videos), video-id lookups silently do nothing, and the "server can search by uuid" check is wrongly cached as false. | Downloads have their own Pause flag. Lookups and folder loads are never cut short by an old Pause. A failed page of a video list is retried once and reported in the log instead of silently dropped. |
| 2 | Jobs the server reports as `CANCELED` or `ABSENT` (both final in the site's own app) are treated as running and polled forever. | They become `failed` with a reason, so Retry works. |
| 3 | Status polling runs every 15 s even if the last pass is still going, so passes can overlap and write over each other's results. A status call that keeps failing (an unknown job returns HTTP 500) is logged every 15 s forever. | One pass at a time, results merge onto the latest saved record, and history is saved once per pass. Failures are logged on the 1st and every 10th try. After 20+ failures over 30+ minutes with HTTP 500/404, the newest My AI Videos are checked: the item becomes `completed` (video found) or `failed` (not found). |
| 4 | Pause waits for the full parallel-limit delay (60 s by default) before it takes effect. | Pause takes effect within half a second. |
| 5 | Retry on an item the running queue has already passed does nothing until the next Start, although the log says it will be retried. | Those items run at the end of the current pass. |
| 6 | Failure reasons show "400 Bad Request" or "no detail from server" for JSON errors, plan limits (`msg`) and blocked words. A plan limit (`isUserLimit`) fails every remaining item one by one. | The server's message is shown (with the blocked word). A plan limit pauses the queue and says why. |
| 7 | AI-generated images (for example from Image maker) carry their own image-job uuid, so the Video maker queue shows them as "submitted" and doesn't count them as ready. | Image uuids no longer count as video jobs. |
| 8 | An item left in `started` with no job id (page closed or reloaded mid-request) is skipped forever and has no Retry button. | After 10 minutes it shows as "stuck", counts as "need retry", and can be retried. |
| 9 | Session auto-delete falls back to matching the folder by name. If the session folder is gone but another folder has the same name, that folder and its files are deleted. | When the session's folder id is known, only that folder can be deleted. |
| 10 | Character descriptions are written into inputs with the URL escaper, so `(` and `)` turn into `%28` / `%29` after the list re-renders, and the mangled text is then saved and sent in prompts. | Inputs and tooltips use plain HTML escaping. |
| 11 | Counters and labels: the folder count always says 5, the Collect filter count always says "—", the context bar keeps demo text ("product-shots-04", "8 images") until folders load and doesn't update after loading images, the upload summary shows the image count from before the upload, and two hints name buttons that don't exist ("Show images in folder", "Add Completed Generated"). | Real numbers and matching button names. |
| 12 | Collect's "Clear filters" sets the date range to today instead of clearing it, and "today" is the UTC date, so in the evening (west of UTC) or early morning (east of UTC) the default filter hides today's videos. | Clear filters clears the dates. "Today" is the local date. |
| 13 | The event log grows without limit during long unattended runs. | It keeps the newest 500 lines. |
| 14 | History is saved as pretty-printed JSON on every change. When browser storage is full the save throws and stops the queue. | Compact JSON. When storage is full, stored server responses of finished items are dropped and the save is retried; if it still fails the log says so once and the run continues. |

## New features

| # | Feature | Where |
|---|---|---|
| 15 | **Wait for a free video slot.** Before sending a video request, the queue and Image → Video count this account's videos that are still rendering (from history, last 60 min) and wait while 5 are running, instead of sending a request the server rejects and then sleeping 60 s. Safety: after 30 minutes it sends anyway; if the server accepts that request, slot waiting is turned off for the rest of the run. | Generate (Video maker, Image → Video) |
| 16 | **Time estimates.** Running items show elapsed time and the server's remaining-time estimate (`status/{uuid}?upd_estimated_time=1`, the call the site itself makes). | Queue preview |
| 17 | **Auto-download.** Downloads each video of the active folder as soon as it finishes, counting from when the box is ticked. | Generate → Completed |
| 18 | **Remaining only.** Downloads only completed videos that were not downloaded yet (the button existed but was hidden). | Generate → Completed |
| 19 | **Queue filter.** All / Ready / Running / Done / Needs retry. | Queue preview |
| 20 | **Upload: skip existing and retry failed.** Files whose name is already in the folder are skipped (on by default in labs), and a "Retry N failed" button re-sends files that failed. | Library → Add images |
| 21 | **Progress at a glance.** The tab title shows `[VE ▶ 12/50]` while a run is active, step tabs show an activity dot, and the context bar notes when the queue runs in a different folder from the one you're viewing. | Header / steps / context bar |
| 22 | **Backup and log tools.** Export the queue history to JSON and import it back (new items are added, newer `updatedAt` wins, malformed keys are skipped). Copy or clear the event log. | Log tab |

## How it was checked

- `node --check` and the existing `node --test tests/` suite (version expectations updated for 0.10.0).
- A local browser harness (kept out of the repo in `temp/labs-e2e/`, which is gitignored): a mock of the VideoExpress endpoints with a 5-job parallel limit, plan-limit / blocked-word / CANCELED / ABSENT / failing jobs, slow downloads and a fake full storage, driven in headless Chrome with `app.videoexpress.ai` mapped to localhost. Each fix is checked twice: Stable still shows the old behaviour and Try new features shows the new one. 71 checks pass.

Not checked against the live site: everything above ran against the mock. The ETA fields and final job states follow the captured traffic in `docs/videoexpress-site-reference.md`.
