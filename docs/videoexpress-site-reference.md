# VideoExpress.ai: how the site works

Reference for `https://app.videoexpress.ai/`, written for work on `videoexpress-manager.user.js`.

How this was gathered (13 Nov 2026, app version `24.25`, logged in as an All Access account):

- Clicking through the live UI in Chrome and recording its network traffic.
- Reading the app bundle `/bundle/js/videoeditor.min.js?24.25` and the UI templates in the page HTML.
- Real test calls, all inside a test folder `zz-kiro-test`: one folder create, one item copy, one upload, and eight image-to-video jobs.

Each endpoint is marked **[verified]** (called and response seen) or **[source]** (read from the bundle only, not called).

`site_design.html` in this repo is an older saved copy of the page (version `22.47`). The live page is newer.

---

## 1. Architecture

- **Single-page app**: one page at `/`, built with jQuery + Backbone/Marionette. The global `app` object holds modules: `mediaLibraryModule`, `timelineModule`, `videoServicesModule`, `inpaintingModule`, `avatarsModule`, `animationsModule`, `projectsModule`, `filtersModule`, `playerModule`, `wizardModule` and others.
- **Boot options**: set in `app.start({...})` in the page HTML. Useful values:
  - `baseUrl: "/"`, `actionPath: "/"`
  - `wsServerUrl: "wss://ws.talkingphotos.ai/"`
  - `defaultAspectRatio: "16:9"`
  - `textToSpeechLimit: 2400`, `textToSpeechCharactersLimitCloneVoice: 6000`
  - `humanTalkingVideoMaxLengthSeconds: 300`
  - `autoShareCreations: true`, `maintenanceMode`
- **UI templates**: `<script type="text/template" id="...">` blocks in the page HTML (82 of them), rendered with Underscore templates.
- **Auth**: the session cookies `PHPSESSID` and `REMEMBERME` on `app.videoexpress.ai`. Every call in this survey worked with the cookie alone. No CSRF header or bearer token was needed for library or AI endpoints. Two exceptions:
  - The two-factor forms post a `_csrf_token` field.
  - A `403` makes the app reload the page; a `401` with `login_url` sends it to `/login`.
- **Request format**: mostly jQuery `$.ajax`, so POST bodies are `application/x-www-form-urlencoded` unless noted as JSON. A generic helper `app.ajaxRequest(data)` POSTs to `data.actionPath` (default `/action`) with `actionPath` removed from the body.
- **File hosting**: files live on CDN hosts such as `https://cdn-ny-b.videoexpress.ai/`, under `/image/<fileName>.<ext>`, `/video/<fileName>.mp4` and `/thumbnail/<fileName>_small.jpg`. A media item's `mediaPath` is its full CDN URL.
- **Retention**: the Media Library banner says project files are hosted for **50 days**.

## 2. Screen layout

- **Top bar**:
  - New, Open, Save (dropdown: Save Project As, Export Project)
  - Export Video, My Videos, My Purchases
  - Public Gallery (`/gallery/`)
  - Workflows (external link, `videoexpress.ai/workflow/`)
  - Tutorials, Support, News
  - User menu: Edit profile, My Purchases, Public Gallery, Terms, Privacy Policy, Disclaimer, Log out (`/logout`)
- **Left**: aspect switch, Landscape 16:9 or Vertical 9:16 (some places also offer Square 1:1).
- **Centre**: preview player.
- **Bottom**: timeline with 2 tracks by default. Toolbar: undo/redo, zoom, add track, copy/paste, split, save frame. Per-track buttons: auto-align, fast cut, mute, hide video, delete.
- **Right rail** (each opens a side panel):

| Rail button | What it opens |
|---|---|
| Media Library | Library browser (section 3) |
| Create with AI | AI generator list (section 4) |
| Import Media / Text to Speech | Text to Speech, CloneVoice.ai TTS and import, Import from Artistly, WebCam Recorder, Voice Recorder, Screen Recorder |
| Text Animations | 3-step wizard. Categories: `lower-third`, `intro`, `outro`, `text-animation`, `text-effect` |
| Filters | Drag onto timeline media: Camera Pan, Resize And Move, Green Screen, Titles, Auto Crop, Zoom In, Audio Wave, Change Speed, Fade In/Out Audio, Opacity |
| Fast Cut | Fast-cut transitions between clips. Pick a track; styles `zoom`, `rotation`, `rotation_nonstop` |
| Automatic Captions | External link to `vidsubtitleapp.com` |
| Audio Cutter | Splits an audio file into equal parts, max 300 s per clip |

## 3. Media Library

### 3.1 Libraries

The panel tabs map to numeric library IDs:

| Tab | `libraryId` | Owner | Example folders |
|---|---|---|---|
| My Media | **4** | you | your folders, plus the built-in AI folders below |
| Stock | 6 | site | Images (38073), Video (38074). Both were empty when checked |
| Video | 1 | site | Animals, Backgrounds, Nature, People, Timelapse, … (22 folders) |
| Audio | 2 | site | Ambient, Effects, Voiceover |
| Images | 3 | site | Abstract, Food and Drink, Outdoors, People, my images |

**Built-in folders inside My Media.** The IDs below are for this account only. Other accounts have different IDs, so look these up by title.

| Title | `name` | id | `sortOrder` | What lands there |
|---|---|---|---|---|
| My AI Videos | `my_ai_videos` | 567535 | 4 | **Every generated video** (6,464+ items) |
| My AI Images | `my_ai_images` | 567536 | 5 | Generated or saved AI images |
| My AI Audio | `my_ai_audio` | 596388 | 1 | Extracted, split and generated audio |

User folders have `sortOrder: 0`. The "Move" and "Copy" dialogs hide the AI folders (and "My Artistly Images") from the target list.

### 3.2 Folder view controls

- **Sort** (`select[name=order]`): `name`, `newest`, `oldest`. The request sends `orderBy=name|id` and `orderDir=asc|desc`.
- **Buttons**: Search, Expand, **Upload file**, **Multi-Select**, More (next page), Back.
- **Multi-select actions**:
  - Move: `library/move_items`
  - Delete: `library/delete_items`
  - Download as zip: `library/download_items`, max 300 MB total
- **Thumbs up/down** on each item: `PATCH library/feedback/{id}`.

### 3.3 Item right-click menus

- **Image**: Preview, Download, Add to Timeline, Organize (Rename, Move, Copy), Delete.
- **Video**:
  - Play, Download, Add to Timeline
  - Details, Redesign
  - Fix Video: Fix Quality, Fix Subtitles, Fix Physics (some hidden)
  - Voice Changer, Save Audio, Save Last Frame
  - Organize
  - Delete, Create work copy, Share (public gallery)
- **Audio**: Voice Changer, plus the common items.

The template's full action list: `preview play play_original download add-to-timeline details_media redesign_media video_fix_quality video_fix_physics video_fix_subtitles video_fix_quality_v3 extend_media voice_changer human_talking_video_repair extract_audio extract_last_frame replace_background rename move copy delete create_work_copy share ai_task_preview`.

### 3.4 Media item object

This is what `get_media` and `get_media_item` return. Key fields:

```jsonc
{
  "id": 48646924,                 // media id, used by every item endpoint
  "name": "A slow cinematic medium shot with a gentle camera push-in mo...",
  "fileName": "1794580054_6af71e56c8d4d",   // CDN file stem
  "extension": "mp4", "imageExtension": "png",
  "type": "video",                // "image" | "video" | "audio" | ...
  "libraryId": 4,
  "datetime": "2026-11-13T14:27:34+00:00",
  "duration": 5041.667,           // milliseconds (0 for images, null while pending)
  "frameSize": "1920x1080", "frameRate": 24,
  "size": 7091788,                // bytes (0 while pending)
  "isPrivate": true,
  "mediaInfo": { /* ffprobe stream info for video/audio, [] for images */ },
  "thumbUrl": "https://cdn-ny-b.videoexpress.ai/thumbnail/<fileName>_small.jpg",
  "mediaPath": "https://cdn-ny-b.videoexpress.ai/video/<fileName>.mp4",  // null while pending
  "imagePath": "https://cdn-ny-b.videoexpress.ai/image/<fileName>.png",  // AI items: the source/first frame
  "isAiGenerated": true,          // null for uploads
  "isShared": false,              // public gallery
  "isPending": true,              // true while the AI job runs
  "status": "processing",         // "processing" -> "completed" (null for uploads)
  "uuid": "4f8b28ac-...",         // AI job id (null for uploads)
  "estimatedTimeSeconds": 240,
  "feedback": 0                   // 1 = thumbs up, -1 = thumbs down
}
```

`get_media` returns `{"total": "96", "results": [...]}`. Note that `total` is a **string**.

## 4. Create with AI

Each tile opens a dialog. Every dialog sends a `generatorName` that identifies it. Values found in the bundle: `create_from_prompt`, `first_last_frame`, `smart_edit`, `consistent_character`, `stylize_character`, `human_talking_video`, `video_from_text`, `video_length_booster`, `ai_face_swap`, `create_sound_from_video`. Older videos also show `video_from_image` in their stored data.

| Tile | Sub-features | Main endpoint(s) |
|---|---|---|
| **Create Video From Prompt** (3.5) | Image to Video, Lipsync HD, Narrate, Consistent Character | `generate_image`, then `image2video` |
| **Text To Video** (3.5) | Lipsync HD; Simple/Advanced tabs; Actor 1/2 scripts | `generate_text2video_dialog` |
| **First Frame, Last Frame** | Image to Video, Lipsync HD | `image2video` with `lastFrameUuid`/`lastFrameMediaId` |
| **Smart Edit** | Inpainting, Object Removal, Background Removal; 1–2 reference photos | `generate_image_consistent_character`, `save_generated_image` |
| **Stylize Character** | styles `realistic`, `3d_pixar`, `anime`, `comic_book`, `line_art`, `watercolor` | `generate_image_stylize_character` |
| **Image To Video (Old Algorithm)** | Video Length Booster | `generate_image2video2` |
| **Lipsync Video (Old, up to 5 min)** | Lipsync, Consistent Character; singing mode; "reverse for smoother video" | `create_talking_video`, `image2video_talking` |
| **Outpainting 2.0** | change aspect ratio | `outpainting_image` |
| **AI Sound Maker** | Sound from Prompt (2–7 s), Sound from Video | sound endpoints |
| **Inpainting** | image or video | `inpainting_image`, `inpainting_video` |

### 4.1 Create Video From Prompt dialog

This is the flow the userscript copies. Fields:

- `prompt`: Image Prompt.
- `video_prompt`: "Video and Audio Prompt". The label becomes "Video Prompt" when Narration is on.
- `select-type`: `human`, `2d`, `3d`, `photorealistic`, `other`.
- Aspect buttons: `16:9`, `9:16`.
- Checkboxes and their defaults:
  - `image_creative_mode`: off
  - `auto_enhance_prompt`: on
  - `use_consistent_character`: off
  - `talking_video` (Lipsync HD): off
  - `narration_video`: off
  - **`shared`: on** (public gallery)
  - `advanced_mode`: off
- Advanced Mode reveals:
  - `enhance_video_prompt`: on
  - `video_only` (no sound): off
  - `manual_video_length`: off
  - `video_duration` slider: **min 3, max 10**, default 5
- Buttons: Use from Library, Enhance Prompt, Create Image, Consistent Character, Create Video.

What the dialog sends on **Create Video** (`ai/api/image2video`):

```
type, imagePrompt, prompt, uuid, mediaId, audioMediaId, isShared, aspect,
videoLength, enhanceHumanFace, isTalkingVideoFromText, isNarrationVideo,
enhanceVideoPrompt, videoOnly, speed, generatorName=create_from_prompt,
faceImageMediaId, faceSwap, mode
```

- `videoLength` is **left out** unless Advanced Mode and Manual Video Length are both on.
- If the image came from the library, `mediaId` is that image's id and `uuid` is empty.
- If the image was generated in the dialog, `uuid` is the image job's uuid.

## 5. AI job lifecycle (verified with real jobs)

1. **Submit** `POST /ai/api/image2video`.
   - Success: `{"success":true,"uuid":"<uuid>","estimatedTimeSeconds":0}`.
   - A media item appears **at once in "My AI Videos"**, not in the folder holding the source image. It has `isPending:true`, `status:"processing"`, `size:0`, `mediaPath:null`.
2. **Status** `GET /ai/api/status/{uuid}` (the app adds `?upd_estimated_time=1` to get `estimated_time`).
   - While running: `{"status":"RUNNING","server_start_time":"...","estimated_time":240}`.
   - When done: `{"success":false,"status":"SUCCEEDED","message":null}`. **`success` is `false` even on success**; only read `status`.
   - The app treats `SUCCEEDED`, `FAILED`, `ABSENT` and `CANCELED` as final states, and follows `next_uuid` if one is returned.
   - An unknown uuid returns **HTTP 500 with an HTML error page**, not JSON.
3. **WebSocket** `wss://ws.talkingphotos.ai/`. The app connects and sends `{"recipient_uuid":"<uuid>","message":"connected"}`. The server replies `..:: Hello from the Notification Center ::..`. Later it sends one of:
   - a URL (`https://...`): result ready
   - `image2video`: AI video finished (seen about 94 s after submit)
   - `Error: ...`: the job failed
   - `abuse_block`: the account is blocked
   - a JSON object
4. **Result**: the item becomes `status:"completed"`, `isPending:false`, with real `duration`, `size` and `mediaPath`.

Measured on these test jobs:

| Item | Result |
|---|---|
| Time to finish | under 200 s for a 5 s video. The server estimate said 240 s |
| `videoLength` | 3 gave 3.04 s, 5 gave 5.04 s, **15 gave 10.04 s** (the server caps it at 10 s). Without `videoLength`, older jobs came out 4 s or 10 s |
| Output | 1920×1080 at 24 fps for 16:9; about 1.4 MB per second |
| Video name, `enhanceVideoPrompt=0` | the prompt with its first letter capitalised, e.g. "Gentle camera drift, test 1" |
| Video name, `enhanceVideoPrompt=1` | the server's rewritten prompt, cut to 60 characters plus "..." |
| Parallel limit | the **6th** job sent while 5 were running got **HTTP 400** `{"error":"You currently have multiple videos in progress. You can generate up to 5 AI videos in parallel to ensure industry leading rendering times. Please wait until one or more of your videos are finished before creating new videos."}` |

Other failure shapes in the source: `{"success":false,"isUserLimit":true,"msg":"..."}` (plan limit, shown as a Warning dialog) and `{"error":"...","badWord":"..."}` (prompt blocked by the word filter).

**Job details**: `GET /ai/api/get_media_prompt_data/{mediaId}` returns `data` with:

- `prompt`, `videoPrompt` and `secretPrompt` (the server's rewritten prompt)
- `type`, `aspect`, `generatorName`, `seed`
- `num_frames`, `width`, `height`
- `imageMediaId` (**source image id**, present on some jobs) and `imageUrl`

It also returns `mode` (`"redesign"`) and `status`. This is the only way found to link a video back to its source image.

## 6. Endpoint reference

All paths are relative to `https://app.videoexpress.ai/`. "form" means a urlencoded POST body.

### 6.1 Library

| Method | Path | Body / query | Response | |
|---|---|---|---|---|
| GET | `library/get_categories/{libraryId}` | — | `{"data":[{id,name,title,libraryId,userId,sortOrder}]}` | verified |
| GET | `api/library/get_media/{libraryId}` | `categoryId, page, start, limit, query, orderBy(id\|name), orderDir(asc\|desc), filter` | `{"total":"N","results":[item]}` | verified |
| GET | `library/get_media_item/{id}` | — | one item | verified |
| POST | `library/add_category/{libraryId}` | form `categoryName` | `{"success":true}` (**no id returned**; reload the list to find it) | verified |
| POST | `library/rename_category/{id}` | form `new_name` | `{success,title,name}` | source |
| DELETE | `library/delete_category/{id}` | — | — | source |
| POST | `library/empty_category/{id}` | form `action=start`, then `action=process&operationId&batchSize=5` repeated until `complete` | progress JSON | source |
| POST | `library/upload/{libraryId}` | multipart `title, categoryId, file` | plain text **`OK`** | verified |
| POST | `library/copy_item/{id}` | form `categoryId` | `{"success":true}` | verified |
| POST | `library/move_item/{id}` | form `categoryId` | `{"success":true}` | source |
| POST | `library/move_items` | JSON `{ids:[...], categoryId}` | `{movedIds}` | source |
| POST | `library/edit_item/{id}` | form `name` (rename) | `{"success":true}` | source |
| DELETE | `library/delete_item/{id}` | — | — | source |
| POST | `library/delete_items` | JSON `{ids:[...]}` | `{deletedIds}` | source |
| GET/HEAD | `library/download/{id}` | — | the file; `Content-Disposition: attachment; filename="<name, '...' → '___'>.mp4"` | verified |
| POST | `library/download_items` | form `ids[]` (≤ 300 MB total) | zip download | source |
| PATCH | `library/feedback/{id}` | JSON `{feedback: 1\|-1\|0}` | `{"success":true,"feedback":N}` | verified |
| POST | `library/share_item/{id}` | — | `{success,isShared}`. Flips public gallery sharing on or off | source |
| POST | `library/extract_audio/{id}` | form `name, startTime, endTime` | goes to My AI Audio | source |
| POST | `library/extract_last_frame/{id}` | form `name[, frame_time_ms]` | new image | source |
| POST | `library/separate_audio_video/{mediaId}` | — | `{video,audio}` | source |
| GET | `library/image/{type}?src=&isPrivate=&w=&h=` | — | resized thumbnail | source |
| GET | `library/get_scripts/` | — | script presets for TTS | source |

### 6.2 AI (`ai/api/...`)

| Method | Path | Main fields | |
|---|---|---|---|
| POST | `image2video` | see section 4.1. First/last frame adds `lastFrameUuid, lastFrameMediaId` | verified |
| GET | `status/{uuid}[?upd_estimated_time=1]` | — | verified |
| GET/POST | `get_media_prompt_data/{mediaId}` | POST JSON `{mode}` for redesign | verified (GET) |
| POST | `generate_image` | `prompt, enhancePrompt, type, uuid, mediaId, seed, aspect, generatorName` | source |
| POST | `save_generated_image` | `uuid, isShared, generatorName` (returns `mediaId`) | source |
| POST | `generate_text2video_dialog` | `prompt, aspect, isShared, generatorName, mode(basic\|advanced), speech1, speech2[, videoLength, enhanceVideoPrompt]` | source |
| POST | `generate_image_consistent_character` | `prompt, type, mediaId, mediaId2, aspect, generatorName` | source |
| POST | `generate_image_stylize_character` | `style, mediaId, aspect, generatorName` | source |
| POST | `generate_image2video2` | `type, mediaId, prompt, videoLengthBooster` (old algorithm) | source |
| POST | `image2video_talking` | `type, prompt, motion, uuid, mediaId, audioMediaId, isShared, isSingingMode` (`repair=1` to repair) | source |
| POST | `create_talking_video` | `prompt, speed, aspect, audioMediaId, imageMediaId/mediaId, isSingingMode, isLoopForwardMode, generatorName, …` | source |
| POST | `face_swap_image` | `prompt, type, sourceMediaId, targetMediaId, aspect, generatorName` | source |
| POST | `human_background_replace` | `uuid, mediaId, prompt, promptNegative, backgroundMediaId, title` | source |
| POST | `outpainting_image` | `prompt, promptNegative, type, mediaId, aspect` | source |
| POST | `inpainting_image` / `inpainting_video` | `prompt, promptNegative, imageData(mask PNG data URL), mediaId, imageUuid, brushColor` | source |
| POST | `video_length_booster` | `videoMediaId, generatorName` | source |
| POST | `create_audio_voice_change` | `referenceAudioId, sourceAudioId, startTime, endTime` | source |
| POST | `audio_split` | JSON (Audio Cutter) | source |
| POST | `extend_prompt/{kind}` | `kind` = `image`, `text_to_video`, `video`, `magic`, `image_to_prompt`. Returns `{prompt}` | source |
| POST | `result_ai_fix/{fix}/{mediaId}` | Fix Video submenu | source |
| POST | `retry/{uuid}` · `cancel/{uuid}` | retry or cancel a job | source |
| GET | `get_log_value_by_uid/{uid}` | job log/preview | source |
| GET | `locked_message/{role}` | upgrade message for locked features | source |
| POST | `voice_recognize` | multipart `audio` (voice typing into prompts) | source |
| POST | `import_from_artistly` | JSON list of images | source |

### 6.3 Projects, rendering, account, misc

| Method | Path | Purpose | |
|---|---|---|---|
| GET | `project/get_list[?search=]` | Open Project list | verified |
| GET | `project/open/{id}` | load a project | source |
| POST | `project/save/{id}` | `title, data(JSON timeline), save_new` | source |
| GET | `project/export/{id}` | Export Project (zip) | source |
| POST | `project/upload` | import a project file | source |
| POST | `render_project/{projectId\|tmp}` | Export Video. JSON `{options:{name,quality(low/medium/high),size(720/1080),format(mp4/webm/mp3/wav),aspect,…},data}` | source |
| GET | `project/progress?start=` · `project/process_stop` | render progress and stop | source |
| GET | `user_queue` | render queue `{results,in_progress,total}` | verified |
| GET | `api/get_list_output` | My Videos (rendered exports, not AI videos) | verified |
| GET | `api/get_profile` · POST `api/update_profile` | profile | verified (GET) |
| POST | `api/api_key_refresh` | creates a new "VideoExpress API key" (no public docs for it were found) | source |
| POST | `api/update_default_aspect_ratio` | `update_ratio, default_aspect_ratio` | source |
| GET | `api/user_upgrades/my` | My Purchases | verified |
| GET | `api/get_restrictions_by_role/{key}?user_role=` | plan limits, e.g. `movie_length` → `[600,600]` | verified |
| GET | `get_news` | News dialog | verified |
| GET | `animations/list/{category}` | Text Animations list | verified |
| GET | `text_to_speech/languages_list` · `text_to_speech/voices/{lang}` | TTS options | source |
| POST | `import/text_to_speech` · `import/youtube/{videoId}` | import speech or a YouTube video | source |
| * | `voice_clone/...` | CloneVoice.ai integration | source |
| POST | `terms/agree` | accept terms | source |

The bundle also contains admin-only endpoints (`api/users_list`, `admin/user/{id}`, `api/jvzoo_*`, `api/show_log`). They are not usable from a normal account.

## 7. What this means for the userscript

These are notes only; the script has not been changed.

1. **Generated videos go to "My AI Videos", not the source folder.** The Downloads tab only lists videos in the selected folder, so it won't find the results of a queue run. Folders like "Chuck" have videos only because they were moved there. To match a video to its image, use the job `uuid` the queue already saves in history (it equals the video item's `uuid`), or `get_media_prompt_data` → `data.imageMediaId`.
2. **Video length is capped at 10 s on the server.** The UI slider runs 3–10. The script's input allows up to 60, but anything above 10 comes out as 10 s.
3. **Parallel limit**: the server returns HTTP 400 with a JSON `error`, not a 200 response with a message. The script's `assertOk` throws, and the `catch` path finds "multiple videos in progress", so the retry still works. The limit is 5 running jobs.
4. **Status**: `success:false` with `status:"SUCCEEDED"` means finished. The script reads `status`, which is correct. An unknown uuid returns HTTP 500 HTML, which shows up as a status-check failure in the log.
5. **Numeric file names give empty prompts.** Names like `1.png` are turned into an empty prompt by `cleanPrompt` (it strips digits), so those items are skipped. Use the master prompt or the prompt list for such folders.
6. **Public gallery**: the UI shares by default (`shared` checked, `autoShareCreations: true`). The script sends `isShared` from the media item, which is usually `null` for uploads, so it sends `0`.
7. **Video names**: with `enhanceVideoPrompt=1` (the script's setting), videos are named after the server's rewritten prompt, cut to 60 characters, not after the image. Downloaded file names follow that name.
8. **Response formats**: `add_category` doesn't return the new id, so the script reloads the list to find it, which is correct. `upload` returns plain `OK`.
9. **Auth**: no CSRF or bearer token was needed; the session cookie was enough. The script's token capture does no harm.

## 7b. Image generation (verified 13 Nov 2026, used by the userscript's Image maker / Image → Video modes)

| Step | Call | Result |
|---|---|---|
| Enhance prompt (optional) | POST `ai/api/extend_prompt/image` form `prompt, imageType` | `{"success":true,"uuid":"vev3_p2i_enhance_…","prompt":"<rewritten>"}` |
| Enhance, consistent character | POST `ai/api/extend_prompt/consistent_character` form `prompt, imageType, imageMediaId, imageMediaId2` | same shape; the rewrite says "Preserve the same …" |
| Generate | POST `ai/api/generate_image` form `prompt, enhancePrompt=0, type, uuid="", mediaId=0, seed="", aspect, generatorName=create_from_prompt` | `{"success":true,"uuid":"…"}` |
| Generate, same character | POST `ai/api/generate_image_consistent_character` form `prompt, type, mediaId, mediaId2, aspect, generatorName` | `{"success":true,"uuid":"…"}` |
| Done signal | WebSocket sends `https://user-assets.renderplatform.com/preview/<uuid>.jpg` after ~9–15 s | the preview URL returns 404 until ready, then 200 |
| Save | POST `ai/api/save_generated_image` form `uuid, isShared=0, generatorName` | before ready: **HTTP 400 `{"error":"Image is empty."}`**; after: `{"success":true,"mediaId":N}` into "My AI Images". Each extra call saves another copy |

- `ai/api/status/{uuid}` does **not** work for image jobs (HTTP 500 HTML).
- No parallel limit seen for images: 8 at once were all accepted.
- 16:9 images come out 1920×1088 (image2video still accepts them and outputs 1920×1080).
- The saved image's name is the prompt with a capital first letter. `library/edit_item/{id}` form `name` renames (verified); the site trims long names to about 50 characters.
- `library/move_item/{id}` form `categoryId` works on images and on **pending videos**; a moved pending video finishes in its new folder (verified).
- A video's name changes to the enhanced prompt when it finishes, sometimes a few seconds after the status says `SUCCEEDED`. Rename after that, then check again.
- `image2video` with `mediaId` of the saved image (and `uuid=""`) works for generated images.

## 8. Test items created during this survey

| Item | Location |
|---|---|
| Folder `zz-kiro-test` (id 658929) | My Media |
| Image `1` (id 48646893, copy of 46988198) | `zz-kiro-test` |
| Image `Kiro-upload-test` (id 48647817, 1280×720 test gradient) | `zz-kiro-test` |
| 7 test videos: 48646924, 48647348, 48647352, 48647364, 48647382, 48647389, 48647825 ("Gentle camera drift, test 1–5", "Slow drift, length test", "A slow cinematic medium shot…") | My AI Videos |

One thumbs-up was set by mistake on video 43549211 and set back to 0.
