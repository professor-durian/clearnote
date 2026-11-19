# ClearNote — a botless AI meeting assistant

Captures Google Meet, Zoom and Teams transcripts from the **captions the platform
already generates**, then writes the summary, action items and insights. No bot
joins the call, and no audio is recorded.

```
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────┐
│ Chrome extension     │        │ Local server          │        │ Claude       │
│                      │ HTTP   │                       │  API   │              │
│ caption DOM ──────▶  │ ─────▶ │  SQLite + FTS5        │ ─────▶ │ opus-5-5     │
│ segmenter            │        │  dashboard            │ ◀───── │ structured   │
│ in-call sidebar      │        │                       │        │ output       │
└──────────────────────┘        └───────────────────────┘        └──────────────┘
```

## How the capture works

Every meeting platform can already transcribe live, for accessibility. The
extension turns those captions on and reads them out of the page. That is why
nothing joins your call and nothing records audio — the platform does the speech
recognition, ClearNote does everything after it.

The hard part is not reading the captions, it is that **captions are not a
transcript**. Platforms render one caption block per speaker and rewrite it in
place, word by word, while they talk; then they recycle the block for whoever
speaks next, and trim words off the front when a block gets long. Reading the
DOM naively gives you the same sentence thirty times.

`extension/lib/segmenter.js` turns that stream into utterances:

| Caption behaviour | What the segmenter does |
|---|---|
| Block grows word by word | Keeps one open utterance and extends it |
| Block's front is trimmed | Rejoins at the longest overlapping seam |
| Block recycled for new speech | Closes the old utterance, opens a new one |
| Speaker changes in the block | Closes and reopens |
| Two people captioned at once | Tracks each block independently |
| Speech stops | Closes after 2.5s of silence |
| Finished block left on screen | Remembers what it already wrote; never repeats it |
| Speaker resumes in the same block | Emits only the words added since |

Platform class names are compiler-generated and rotate every few releases, so
each adapter tries a list of known selectors and then falls back to the
*structure* of a caption row — the name sits next to the avatar, the speech
sits outside it.

## Quick start (your own copy)

Everything runs on your machine, and your meeting data never leaves it except
the transcript text sent to Anthropic's API if you turn summaries on. You need
macOS, Node 20+, Chrome, and optionally an Anthropic API key.

```bash
git clone <this repo> "$HOME/claude-apps/clearnote"   # not Desktop/Documents/Downloads
cd "$HOME/claude-apps/clearnote/server" && npm install

# Keys live outside the project so they can never be committed:
cat > ~/.clearnote.env <<'EOF'
ANTHROPIC_API_KEY=your-key-here
EOF
chmod 600 ~/.clearnote.env

sh install-agent.sh      # starts the server now and at every login
```

Open `http://localhost:8787`, then load the extension (below). The calendar
integration is optional and needs your own Google OAuth client — see
[Google Calendar](#google-calendar). Nothing is shared between copies: each
install has its own database, key and Google credentials.

Heads-up: captions from other participants are sent to Anthropic when summaries
are on, and recording others may require notice or consent depending on your
workplace and jurisdiction.

## Run it

```bash
cd server && npm install
export ANTHROPIC_API_KEY=sk-ant-...     # without this, transcripts are still captured
npm start                                # http://localhost:8787
```

Then load the extension: Chrome → `chrome://extensions` → Developer mode →
**Load unpacked** → pick the `extension/` folder.

In its Settings, set **Your name**. Every platform labels the local participant
"You", so without it your own lines read as "You" and can never be reconciled
with a calendar invitee. Use the spelling your calendar uses. Also change the
server URL there if it is not on `http://localhost:8787`.

Join a call. A panel appears in the corner showing lines as they are captured.
When you leave, the meeting appears on the dashboard with its summary.

To look at the dashboard before capturing anything real:

```bash
cd server && CLEARNOTE_DB=demo.db node tools/seed.js && CLEARNOTE_DB=demo.db npm start
```

## What it does

**Capture** — Google Meet, Zoom web client, Teams web client. Captions switched
on automatically, speaker names, timestamps, in-call sidebar, works on
unscheduled meetings because it reacts to the page rather than to a calendar.

**Calendar** — matches each meeting to its Google Calendar event by conference
link, time and title; adopts the real title; shows who was invited and who
never spoke; asks instead of guessing when two events overlap.

**After the call** — summary with key points, decisions and open questions;
action items with owner, due date and priority; insights (objections, buying
signals, risks, competitor mentions, pricing, commitments); auto-tagging;
per-meeting chat.

**The transcript** — full text with timestamps, editable in place, speaker
rename across the whole meeting, full-text search across every meeting.
**Download .txt** exports the meeting — summary, action items and transcript —
as plain text named by date and title. **Delete** removes a meeting, its
transcript, its action items and its search entries, and is not undoable.

## Google Calendar

Matching a captured meeting to its calendar event gives you the real title, the
agenda, and — the part a transcript cannot give you — **who was invited but
never spoke**.

### Connecting

You need your own Google OAuth client; there is no shared one to borrow.

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → External → add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised redirect URI: `http://localhost:8787/api/google/callback`
5. Put the client id and secret in the server's environment:

```bash
export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=...
npm start
```

Then open the dashboard → **Settings → Connect Google Calendar**.

The scope is `calendar.events.readonly`. ClearNote never writes to your
calendar. Tokens are stored in the same local SQLite file as the transcripts,
so once connected, treat that file as a secret.

### How a meeting is matched

Three signals, worth very different amounts:

| Signal | Meaning | Confidence |
|---|---|---|
| **Link** | the event carries the same conference code you were in | high |
| **Link, off-schedule** | same room, wrong time — a standing room reused | medium |
| **Time + title** | overlapping slot and a similar name | medium |
| **Time only** | overlapping slot, nothing else | low |

The link is an *identity* match — nothing else gives that — so it wins even
when the clock disagrees. Time alone is weak: back-to-back calls overlap and
people run over. **When two events are equally plausible on time alone,
ClearNote matches neither and asks you**, rather than being confidently wrong
about whose name goes on an action item.

Every match is shown with how it was made, and can be corrected on the meeting
page ("Change" → pick the event, or "Not on the calendar").

A calendar title replaces a platform-generated one like `Meet abc-defg-hij`,
but **never** replaces a title you typed yourself.

Invitees are also fed to the AI pass, so action-item owners come out as real
people rather than as whatever spelling the captions produced.

This is why **Your name** in the extension's settings matters: the platform
calls you "You", and "You" matches nobody on the invitee list. For meetings
captured before you set it, rename the speaker from the transcript (click the
✎ beside a line) — that rewrites every line they spoke.

### What it does not do

- **Capture is not triggered by the calendar.** The extension reacts to being
  in a call, which is why impromptu meetings are captured too. The calendar
  names a meeting after the fact; it does not decide what gets captured.
- **Google Calendar only.** No Outlook/Exchange.
- **One account**, the primary calendar.
- **The OAuth flow has not been run against Google.** It is written to the
  documented flow and the local halves are tested, but no real consent screen
  has been exercised — see **Limits** below.

## Why captions have to be on

Captions **are** the transcription engine. Meet, Zoom and Teams only run speech
recognition while captions are enabled; with them off there is no text anywhere
in the page, and a botless tool that does not record audio has nothing to read.
Every botless extension works this way — IceCubes lists "captions enabled" as a
requirement for Google Meet too.

What you should not have to do is enable them *by hand*. ClearNote turns them
on when you join: it finds the control in the toolbar, falls back to the
**More options** menu, and falls back again to Meet's `c` shortcut, retrying as
the toolbar finishes rendering.

It only ever clicks a control that says it turns captions **on**. That sounds
obvious, but the control flips its own label and Meet sets no `aria-pressed` on
it, so a looser match hits "Turn off captions" and switches off the very thing
being read.

If you would rather not see them, turn on **Hide the platform's caption
overlay** in the extension's settings. The captions keep running and ClearNote
keeps reading them; they are just not drawn on screen, and the same text
appears in ClearNote's own panel. It is off by default — hiding an
accessibility feature is not something to do to someone silently, and anyone
screen-sharing with you may be reading them.

The alternative is to capture tab audio and transcribe it yourself, which works
without captions but means recording the meeting — a different product with
different consent implications.

## Debug mode — tuning selectors against a real call

Turn it on in the extension's Settings ("Log capture details to the page
console"). Two extra buttons appear in the in-call sidebar.

**Diagnose** reports what the adapter can see right now and names the thing to
fix — not a wall of tables:

```
Working, but via the structural fallback — the named selectors have gone stale
and should be updated.

caption region found: true   in call: true
  captionRoot  ✓ div[jsname="dsyhDe"] (1)
  rows         ✗ no selector matched
  speaker      ✗ no selector matched
  text         ✓ [jsname="tgaKEf"] (2)
```

**Record** captures the caption region as it changes. Stop it and you get a
JSON file. Drop that into `tools/caption-replay.html` and the whole meeting
replays through the real adapter: you get the transcript it would have
produced, plus a hit/miss table for every selector. Edit a selector in
`extension/platforms/*.js`, reload, drop the file in again — **a call that went
wrong becomes a fixture you can fix against, without rejoining a meeting.**

Recordings are **redacted by default**. Redaction replaces every word of speech
with same-shape placeholders and maps speaker names to `Speaker A`, `Speaker B`,
while keeping the DOM structure and class names that selector tuning actually
needs. Meeting URLs are cut back to their origin, because a meeting code is
effectively a credential.

```
Ada Lovelace: Ship the pricing page Thursday   →   Speaker A: Xxxx xxx xxxxxxx xxxx Xxxxxxxx
```

So a recording can be shared for debugging without sharing the meeting. Pass
`{redact: false}` if you are only debugging your own call.

From the console there is more control. Content scripts run in an isolated
world, so **switch the DevTools console context from `top` to `ClearNote`**
first — otherwise `__clearnote` is undefined:

```js
__clearnote.show()      // the report above
__clearnote.record()    // start recording
__clearnote.stop()      // stop
__clearnote.save()      // download it, redacted
__clearnote.save({redact: false})
__clearnote.saveProbe() // just the diagnosis, no transcript content
__clearnote.transcript  // what has been captured so far
```

Building this found two bugs in the capture path itself: captions already on
screen when capture started were transcribed as if just spoken (now recorded as
context via `Segmenter.prime`), and simultaneous speakers were emitted in map
order rather than chronologically.

## Layout

```
extension/
  manifest.json          MV3
  icons/                 generated by tools/make-icons.mjs — do not hand-edit
  background.js          settings, durable outbound queue, server handshake
  content.js             picks the adapter, drives capture, detects the call ending
  lib/segmenter.js       rolling captions -> utterances   ← the interesting part
  lib/diagnostics.js     debug mode: probe, recorder, redaction
  lib/util.js            selector helpers with fallbacks
  platforms/             meet.js, zoom.js, teams.js
  ui/                    in-call sidebar, popup, settings
server/
  server.js              REST API + dashboard
  db.js                  SQLite schema, FTS5 index, queries
  matching.js            meeting -> calendar event, pure and heavily tested
  export.js              plain-text export of a meeting
  google.js              Google OAuth + calendar sync
  ai.js                  Claude calls (structured output + meeting chat)
  public/                dashboard (no build step)
  test/                  118 tests
  tools/seed.js          demo meeting
tools/caption-replay.html  replays scripted calls, and recordings from real ones
tools/fixture-replay.js    the recording replayer
tools/make-icons.mjs       draws the icon and writes every size
```

## Send finished captures to another app

Settings › Connections › *Send finished captures to another app* takes a web
address and a signing secret (required; *Generate a secret* makes one), and
which captures to send: calls, YouTube, websites (calls only by default).

When a capture is finished (ended, summarised, audio transcribed), ClearNote
POSTs it there as JSON. Changes later (a regenerated summary, a corrected line,
an edited title) are sent again with a higher `revision`; deleting a capture
sends `meeting.deleted`. Failed deliveries are retried after 1, 2, 4 … minutes,
up to every 6 hours. Only the computer that recorded a capture sends it (and
its deletion), so synced computers never deliver it twice. A new address starts
from now; *Also send past captures* sends the rest.

### Headers

- `X-ClearNote-Event`: `meeting.finished`, `meeting.updated`, `meeting.deleted` or `test`
- `X-ClearNote-Delivery`: a unique id per request
- `X-ClearNote-Timestamp`: Unix seconds when the request was signed
- `X-ClearNote-Signature: sha256=<hex>`: HMAC-SHA256 of `<timestamp>.<raw body>`,
  keyed by the secret. Compare in constant time and reject timestamps more than
  5 minutes old. Retries are signed afresh.

### Body (version 2)

```json
{
  "event": "meeting.finished",
  "version": 2,
  "deliveryId": "…",
  "sentAt": "2026-11-19T08:00:00.000Z",
  "meeting": {
    "id": "…",
    "revision": 1,
    "kind": "call | youtube | web",
    "platform": "Google Meet",
    "platformKey": "google_meet | zoom | teams | youtube | web",
    "title": "Budget review",
    "url": "https://meet.google.com/…",
    "startedAt": "…", "endedAt": "…",
    "recordedOn": "Scott’s MacBook Air",
    "transcriptSource": "captions | audio+captions",
    "summary": { "headline": "…", "tldr": "…", "keyPoints": [], "decisions": [], "openQuestions": [] },
    "actionItems": [{ "text": "…", "owner": "…", "due": "…", "priority": "…", "done": false }],
    "people": [{ "name": "…", "email": "…", "spoke": true, "self": false, "organizer": false }],
    "calendarEvent": {
      "id": "…", "seriesId": "… (recurring events)", "calendarId": "…", "account": "you@example.com",
      "title": "…", "scheduledStart": "…", "scheduledEnd": "…", "organizer": "…", "link": "…"
    },
    "tags": [], "notes": null,
    "transcript": [{ "speaker": "…", "text": "…", "startMs": 0, "endMs": 1500 }],
    "files": {
      "notesDoc": { "id": "<Drive file id>", "url": "…" },
      "audio": { "mixed": { "id": "…", "url": "…" }, "call": { "id": "…", "url": "…" }, "mic": { "id": "…", "url": "…" } }
    }
  }
}
```

`startedAt` is when you joined; `calendarEvent.scheduledStart` is the
calendar's time. `meeting.deleted` carries only `{ "id", "revision" }`.

### Answering

- Any 2xx accepts. Use `meeting.id` as the key and keep the highest `revision`:
  a late request with a lower revision is older and can be ignored.
- Optionally answer `{ "recordId": "…", "url": "https://…", "appName": "kayb" }`:
  the capture's page in ClearNote then shows *Open in kayb*.
- `410 Gone` means "stop sending this capture"; ClearNote won't send it again
  unless you use *Send to app again*.
- Anything else is retried. `test` deliveries carry a sample capture with
  `revision: 0`; accept them without storing.

## The icon

`node tools/make-icons.mjs` draws it and writes `extension/icons/*.png` (16,
32, 48, 128) plus the SVG used by the dashboard and the in-app marks. The shape
is defined once, in that file, as geometry in a 0..1 square — edit the
constants at the top rather than the generated files. PNGs are encoded by hand
so this needs no image dependencies.

The geometry is tuned for 16px, where the icon is actually read: thin bars turn
to mush and a large corner radius reads as a circle rather than a tile.

## Keeping it running (macOS)

By default the server runs only while you have a terminal open. To have it
start at login and restart itself:

```bash
sh server/install-agent.sh
```

The plist in the repo is a template; the script fills in this checkout's path
and your home directory, writes it to `~/Library/LaunchAgents/`, and starts it.
Re-run it after moving the project. Node is found automatically in the usual
Homebrew, Volta and nvm locations; set `CLEARNOTE_NODE` in `~/.clearnote.env`
if yours is elsewhere.

Logs go to `~/Library/Logs/clearnote.log`. To stop it:
`launchctl bootout gui/$(id -u)/com.clearnote.server`.

Secrets go in `~/.clearnote.env` (`chmod 600`), which `server/launch.sh` reads
at startup — launchd starts processes with almost no environment, so an
exported `ANTHROPIC_API_KEY` from your shell never reaches it. The plist holds
no secrets, because plists are world-readable.

**The project must not live in `~/Desktop`, `~/Documents` or `~/Downloads`.**
Those are privacy-protected on macOS and a launchd agent cannot read them — it
fails with `Operation not permitted` (exit 126). Your terminal can, because the
terminal app was granted access; a background agent inherits none of that.

Starting the server by hand still works: `launch.sh` notices a server already
holding the port and exits cleanly, so the agent stands aside rather than
fighting it for the port.

## Tests

```bash
cd server && npm test        # 118 tests, no API key needed, no network
```

The segmenter tests replay the caption behaviour each platform actually
exhibits. The API tests drive the capture endpoints the way the extension does,
including the retry and reconnect paths.

For the adapters, open `tools/caption-replay.html` (serve the repo root, e.g.
`python3 -m http.server 8123`, then visit `/tools/caption-replay.html`). It
replays a scripted conversation through the **real** Meet adapter against a
Meet-shaped DOM, twice: once with Meet's current class names, and once with
every class name changed, to prove the structural fallback still works. It then
records that replay through debug mode, redacts it, and replays the recording
back, asserting it reproduces the same transcript — so the debug pipeline is
tested too. The same page takes recordings from real calls.

This harness found four bugs during development: duplicated lines from finished
caption rows; the speaker and utterance swapped when an utterance was shorter
than the speaker's name; captions already on screen being transcribed as new
speech; and simultaneous speakers coming out in the wrong order.

## Reliability notes

- Segments go into a `chrome.storage.local` queue before being sent. If the
  server is down or the MV3 worker is killed mid-meeting, nothing is lost — the
  queue drains when it comes back.
- Segment sequence numbers are unique per meeting, so a retried batch cannot
  duplicate lines.
- If the server was unreachable when the call began, the extension addresses
  batches by room key and the server routes them to the right meeting.
- A failed summary never costs you the transcript; it is stored first and the
  summary is a separate step you can retry from the dashboard.
- A recurring room is not one endless meeting: a room key is only reused while a
  meeting is still live and recent.

## Limits, honestly

- **Accuracy is the platform's.** ClearNote cannot be more accurate than Meet's
  or Zoom's captions, and those are noticeably worse than Whisper on accented
  speech, crosstalk and technical vocabulary. The AI prompt is written to read
  through that noise rather than quote it.
- **Captions must be available.** Zoom and Teams need the web client, not the
  desktop app — a content script cannot reach a native window. On Zoom, captions
  may be off at the account level, which only an admin can change.
- **Selectors will break.** Google and Microsoft ship obfuscated class names and
  rotate them. The fallbacks buy time; they do not make this maintenance-free.
  Debug mode is the answer: diagnose in the call, record it, replay it offline
  and tune against it. See **Debug mode** above.
- **Not end-to-end encrypted.** IceCubes advertises E2E encryption; this stores
  transcripts in plain SQLite on your machine. That is a smaller claim, but an
  honest one for a local tool. Set `CLEARNOTE_TOKEN` before exposing the server
  beyond localhost.
- **The Google OAuth flow is unexercised.** Token exchange and refresh are
  written to Google's documented flow, but no real consent screen has been
  completed — no credentials were available here. The matching, storage and UI
  around it are tested against seeded events. Expect the first connect to be
  where any surprise shows up.
- **No CRM sync, and no Outlook.** Calendar matching is Google-only, one
  account, primary calendar.
- **Single user.** No accounts, sharing, comments or team permissions.

## License

ClearNote is open source under the [MIT License](LICENSE).
