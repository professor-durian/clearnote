// ClearNote dashboard. Plain JS, no build step; components are Shoelace web
// components (https://shoelace.style), loaded by index.html.

const view = document.getElementById("view");
const qInput = document.getElementById("q");

const api = async (path, opts) => {
  const res = await fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clock = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const when = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
};

const duration = (m) => {
  if (!m.ended_at) return "in progress";
  const min = Math.max(1, Math.round((m.ended_at - m.started_at) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

const tag = (text, variant = "neutral") => `<sl-tag size="small" variant="${variant}" pill>${esc(text)}</sl-tag>`;

/** A short message in the corner. */
function notify(message, variant = "primary") {
  const icon = { success: "check2-circle", danger: "exclamation-octagon", warning: "exclamation-triangle" }[variant] || "info-circle";
  const el = Object.assign(document.createElement("sl-alert"), { variant, closable: true, duration: 5000 });
  el.innerHTML = `<sl-icon slot="icon" name="${icon}"></sl-icon>${esc(message)}`;
  document.body.append(el);
  customElements.whenDefined("sl-alert").then(() => el.toast());
}

/** Open a tab once the tab group and its tabs have rendered. */
async function showTab(group, name) {
  await Promise.all(["sl-tab-group", "sl-tab", "sl-tab-panel"].map((t) => customElements.whenDefined(t)));
  await group.updateComplete;
  requestAnimationFrame(() => group.show(name));
}

const loading = (text) => `<div class="loading"><sl-spinner></sl-spinner>${esc(text)}</div>`;

// ------------------------------------------------------------ status labels

function statusOf(m) {
  let transcript;
  if (m.status === "live") transcript = ["Capturing", "warning"];
  else if (["recording", "transcribing"].includes(m.audioStatus)) transcript = ["Transcribing…", "warning"];
  else if (m.audioStatus === "failed") transcript = ["Audio failed", "danger"];
  else if (m.audioStatus === "waiting") transcript = ["Audio waiting", "warning"];
  else if (m.recordType === "merged") transcript = ["Enhanced", "primary"];
  else if (m.recordType === "partial") transcript = ["Enhanced (part)", "primary"];
  else transcript = ["Captions only", "neutral"];

  const s = m.summary || {};
  let summary;
  if (m.status === "processing") summary = ["Working…", "warning"];
  else if (m.status === "failed") summary = ["Failed", "danger"];
  else if (s.tldr || s.headline) summary = ["Ready", "success"];
  else summary = ["None", "neutral"];

  const sv = m.saved || {};
  const drive = sv.error ? ["Error", "danger"] : sv.savedAt ? ["Saved", "success"] : ["Not saved", "neutral"];
  return { transcript, summary, drive };
}

// ----------------------------------------------------------- shared actions

// Whether "Send finished meetings to another app" has an address (row menu item).
let hookOn = false;
api("/webhook").then((st) => (hookOn = !!st?.enabled)).catch(() => {});

/** The redo actions, shared by the list's row menu and the meeting page. */
async function runAction(action, m) {
  try {
    if (action === "open") return void (location.hash = `#/m/${m.id}`);
    if (action === "drive") return void window.open(m.saved?.notesUrl, "_blank", "noopener");
    if (action === "txt") return void (location.href = `/api/meetings/${m.id}/export.txt`);
    if (action === "retranscribe") {
      await api(`/meetings/${m.id}/retranscribe`, { method: "POST", body: "{}" });
      notify("Re-transcribing the audio. This takes a few minutes for a long call.");
    } else if (action === "summary") {
      notify("Writing the summary…");
      const r = await api(`/meetings/${m.id}/process`, { method: "POST", body: "{}" });
      const s = r.summary || {};
      if (s.tldr || s.headline) notify("Summary updated.", "success");
      else notify(s.error || s.notice || "No summary was written.", s.error ? "danger" : "warning");
    } else if (action === "save") {
      const r = await api(`/meetings/${m.id}/save`, { method: "POST", body: "{}" });
      if (r.error) notify(`Not saved: ${r.error}`, "danger");
      else notify("Saved again.", "success");
    } else if (action === "send") {
      const r = await api(`/meetings/${m.id}/send`, { method: "POST", body: "{}" });
      if (r.ok) notify("Sent.", "success");
      else notify(`Not sent: ${r.error}`, "danger");
    } else if (action === "delete") {
      const label = m.title || `Untitled ${noun(m)}`;
      if (!confirm(`Delete “${label}”?\n\nThe transcript, audio, action items and search entries go with it. Copies already saved to Drive stay there. This cannot be undone.`)) return;
      await api(`/meetings/${m.id}`, { method: "DELETE" });
      notify("Deleted.");
      if (location.hash.startsWith("#/m/")) return void (location.hash = "#/");
    }
    route();
  } catch (err) {
    notify(err.message, "danger");
  }
}

function actionMenu(m, { compact = true } = {}) {
  const hasAudio = m.hasAudio ?? m.audioTracks?.some((t) => t.bytes > 0);
  return `<sl-dropdown placement="bottom-end" hoist data-menu="${esc(m.id)}">
    ${
      compact
        ? `<sl-icon-button slot="trigger" name="three-dots" label="Actions for ${esc(m.title || `this ${noun(m)}`)}"></sl-icon-button>`
        : `<sl-button slot="trigger" caret>More</sl-button>`
    }
    <sl-menu>
      ${compact ? `<sl-menu-item value="open"><sl-icon slot="prefix" name="box-arrow-up-right"></sl-icon>Open</sl-menu-item>` : ""}
      <sl-menu-item value="retranscribe" ${hasAudio ? "" : "disabled"}><sl-icon slot="prefix" name="soundwave"></sl-icon>Transcribe the audio</sl-menu-item>
      <sl-menu-item value="summary"><sl-icon slot="prefix" name="stars"></sl-icon>Regenerate summary</sl-menu-item>
      <sl-menu-item value="save"><sl-icon slot="prefix" name="cloud-upload"></sl-icon>Save to Drive again</sl-menu-item>
      ${hookOn ? `<sl-menu-item value="send"><sl-icon slot="prefix" name="send"></sl-icon>Send to app again</sl-menu-item>` : ""}
      <sl-menu-item value="drive" ${m.saved?.notesUrl ? "" : "disabled"}><sl-icon slot="prefix" name="google"></sl-icon>Open notes in Drive</sl-menu-item>
      <sl-menu-item value="txt"><sl-icon slot="prefix" name="download"></sl-icon>Download transcript (.txt)</sl-menu-item>
      <sl-divider></sl-divider>
      <sl-menu-item value="delete"><sl-icon slot="prefix" name="trash"></sl-icon>Delete…</sl-menu-item>
    </sl-menu>
  </sl-dropdown>`;
}

function wireMenus(byId) {
  for (const dd of view.querySelectorAll("[data-menu]")) {
    dd.addEventListener("sl-select", (e) => runAction(e.detail.item.value, byId(dd.dataset.menu)));
  }
}

// ------------------------------------------------------------ captures list

let listFilter = "all";
let sourceFilter = "all";

// Where a capture came from. Calls have attendees; the rest don't.
const SOURCES = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  youtube: "YouTube",
  web: "Other websites",
};
const CALLS = ["google_meet", "zoom", "teams"];
const isCallCapture = (m) => CALLS.includes(m.platform);
const sourceOf = (m) => (SOURCES[m.platform] && m.platform !== "web" ? SOURCES[m.platform] : "Website");
const noun = (m) => (isCallCapture(m) ? "meeting" : "capture");

async function renderList({ q, tag: tagName, person } = {}) {
  view.innerHTML = loading("Loading captures…");
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tagName) params.set("tag", tagName);
  if (person) params.set("person", person);
  const [all, everyone] = await Promise.all([api(`/meetings?${params}`), api("/people?sort=meetings")]);
  const picked = person ? person.split(",") : [];

  const title = q ? `Results for “${esc(q)}”` : tagName ? `Tagged “${esc(tagName)}” <a href="#/" class="small">clear</a>` : "Captures";
  const peoplePicker = everyone.length
    ? `<sl-select id="pfilter" multiple clearable size="small" placeholder="Filter by people" max-options-visible="2" value="${esc(picked.join(" "))}" style="min-width:240px" hoist>
        ${everyone.map((p) => `<sl-option value="${p.id}">${esc(p.name)} (${p.meetings})</sl-option>`).join("")}
      </sl-select>`
    : "";
  if (!all.length && picked.length) {
    view.innerHTML = `<h1>Captures</h1><div class="row" style="margin-bottom:12px">${peoplePicker}</div>
      <div class="empty"><b>No meetings with everyone you picked.</b><br/>Remove someone from the filter.</div>`;
    wirePeopleFilter();
    return;
  }
  if (!all.length) {
    view.innerHTML = `<h1>${title}</h1><div class="empty">${
      q || tagName
        ? "<b>Nothing matched.</b><br/>Try another term."
        : `<b>Nothing captured yet.</b><br/>Join a Google Meet, Zoom or Teams call in Chrome with the extension installed, or click the
           ClearNote icon on a YouTube video or any page playing sound. The transcript lands here when it ends.`
    }</div>`;
    return;
  }

  const filters = {
    all: ["All", () => true],
    audio: ["With audio", (m) => m.hasAudio],
    unsaved: ["Not saved", (m) => !m.saved?.savedAt],
    problems: ["Problems", (m) => m.audioStatus === "failed" || m.status === "failed" || m.saved?.error],
  };
  // Sources offered: the usual ones, plus any others actually captured.
  const sourceKeys = Object.keys(SOURCES);
  const bySource = (m) =>
    sourceFilter === "all" ||
    (sourceFilter === "calls" ? isCallCapture(m) : (SOURCES[m.platform] ? m.platform : "web") === sourceFilter);
  const shown = all.filter((m) => filters[listFilter][1](m) && bySource(m));
  const counts = (k) => all.filter((m) => (k === "calls" ? isCallCapture(m) : (SOURCES[m.platform] ? m.platform : "web") === k)).length;
  const sourcePicker = `<sl-select id="sfilter" size="small" value="${sourceFilter}" style="min-width:200px" hoist>
      <sl-option value="all">All sources (${all.length})</sl-option>
      <sl-option value="calls">All calls (${counts("calls")})</sl-option>
      ${sourceKeys.map((k) => `<sl-option value="${k}">${SOURCES[k]} (${counts(k)})</sl-option>`).join("")}
    </sl-select>`;

  view.innerHTML = `
    <div class="row" style="align-items:flex-end;margin-bottom:16px">
      <div style="flex:1 1 300px">
        <h1>${title}</h1>
        <p class="sub" style="margin:0">${all.length} capture${all.length === 1 ? "" : "s"}${
          shown.length !== all.length ? `, ${shown.length} shown` : ""
        }. Open one, or use ⋯ to redo a step.</p>
      </div>
      ${sourcePicker}
      ${peoplePicker}
      <sl-radio-group id="filter" value="${listFilter}" size="small">
        ${Object.entries(filters).map(([k, [label]]) => `<sl-radio-button value="${k}">${label}</sl-radio-button>`).join("")}
      </sl-radio-group>
    </div>
    <div class="tablebox">
      <table class="meetings">
        <thead><tr>
          <th>Capture</th><th>Source</th><th>When</th><th>People</th><th>Transcript</th><th>Audio</th><th>Summary</th><th>Drive</th><th><span class="sr">Actions</span></th>
        </tr></thead>
        <tbody>
          ${
            shown.length
              ? shown
                  .map((m) => {
                    const st = statusOf(m);
                    return `<tr>
                      <td>
                        <a class="mtitle" href="#/m/${esc(m.id)}">${esc(m.title || `Untitled ${noun(m)}`)}</a>
                        ${m.summary?.headline ? `<div class="headline">${esc(m.summary.headline)}</div>` : ""}
                      </td>
                      <td>${tag(sourceOf(m), "neutral")}</td>
                      <td style="white-space:nowrap">${when(m.started_at)}<div class="muted small">${duration(m)}${m.sync_device ? ` · ${esc(m.sync_device)}` : ""}</div></td>
                      <td>${
                        !isCallCapture(m)
                          ? `<span class="muted">—</span>`
                          : m.people?.length
                          ? m.people.slice(0, 3).map((p) => `<a href="#/people/${p.id}" class="plink">${esc(p.name)}</a>`).join(", ") +
                            (m.people.length > 3 ? ` <span class="muted">+${m.people.length - 3}</span>` : "")
                          : m.participants.length
                            ? esc(m.participants.slice(0, 3).join(", "))
                            : `<span class="muted">—</span>`
                      }</td>
                      <td>${tag(...st.transcript)}</td>
                      <td>${m.hasAudio ? tag("Recorded", "neutral") : `<span class="muted">—</span>`}</td>
                      <td>${tag(...st.summary)}</td>
                      <td>${m.saved?.error ? `<sl-tooltip content="${esc(m.saved.error)}">${tag(...st.drive)}</sl-tooltip>` : tag(...st.drive)}</td>
                      <td style="text-align:right">${actionMenu(m)}</td>
                    </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="9" class="muted" style="padding:24px 16px">Nothing in this view.</td></tr>`
          }
        </tbody>
      </table>
    </div>`;

  document.getElementById("filter").addEventListener("sl-change", (e) => {
    listFilter = e.target.value;
    route();
  });
  document.getElementById("sfilter").addEventListener("sl-change", (e) => {
    sourceFilter = e.target.value;
    route();
  });
  wireMenus((id) => all.find((m) => m.id === id));
  wirePeopleFilter();
  if (all.some((m) => m.status === "processing" || ["recording", "transcribing"].includes(m.audioStatus))) refreshSoon();
}

function wirePeopleFilter() {
  const sel = document.getElementById("pfilter");
  if (!sel) return;
  sel.addEventListener("sl-change", () => {
    const ids = (Array.isArray(sel.value) ? sel.value : [sel.value]).filter(Boolean);
    location.hash = ids.length ? `#/?person=${ids.join(",")}` : "#/";
  });
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  const at = location.hash;
  refreshTimer = setTimeout(() => {
    // Don't yank the page from under someone typing.
    if (location.hash === at && !view.contains(document.activeElement?.closest?.("[contenteditable], sl-input, input, textarea"))) route();
  }, 6000);
}

// ----------------------------------------------------------- meeting page

const RECORD_TYPE = {
  merged: "Enhanced: words from the audio, speakers from the captions",
  partial: "Audio for part of the call, captions for the rest",
  captions: "Captions only",
};

async function renderMeeting(id, tabName = "notes") {
  view.innerHTML = loading("Loading…");
  const m = await api(`/meetings/${id}`);
  const s = m.summary || {};
  const st = statusOf(m);
  const hasAudio = m.audioTracks?.some((t) => t.bytes > 0);
  const hasSummary = !!(s.tldr || s.headline);

  view.innerHTML = `
    <a href="#/" class="small">← Captures</a>
    <div class="mhead">
      <div class="info">
        <label class="sr" for="mtitle">Title</label>
        <input class="edit-title" id="mtitle" value="${esc(m.title || `Untitled ${noun(m)}`)}" />
        <p class="muted" style="margin:4px 0 8px">${esc(m.platform_label || m.platform)} · ${new Date(m.started_at).toLocaleString([], {
          weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
        })} · ${duration(m)}${m.participants.length ? ` · ${esc(m.participants.join(", "))}` : ""}</p>
        <div class="row">
          ${tag(`Transcript: ${st.transcript[0]}`, st.transcript[1])}
          ${tag(`Summary: ${st.summary[0]}`, st.summary[1])}
          ${tag(m.saved?.savedAt ? `Saved to Drive ${new Date(m.saved.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : m.saved?.error ? "Drive: error" : "Not saved", st.drive[1])}
          ${m.calendarEvent ? tag(`Calendar: ${m.calendarEvent.title}`) : ""}
          ${m.tags.map((t) => `<a href="#/tag/${encodeURIComponent(t)}">${tag(t)}</a>`).join("")}
        </div>
        ${m.saved?.error ? `<sl-alert variant="danger" open style="margin-top:10px"><sl-icon slot="icon" name="exclamation-octagon"></sl-icon>Not saved to Drive: ${esc(m.saved.error)}</sl-alert>` : ""}
      </div>
      <div class="row">
        ${m.saved?.notesUrl ? `<sl-button variant="primary" href="${esc(m.saved.notesUrl)}" target="_blank"><sl-icon slot="prefix" name="google"></sl-icon>Open notes in Drive</sl-button>` : ""}
        ${hasAudio ? `<sl-button data-act="retranscribe"><sl-icon slot="prefix" name="soundwave"></sl-icon>Re-transcribe</sl-button>` : ""}
        <sl-button data-act="summary"><sl-icon slot="prefix" name="stars"></sl-icon>${hasSummary ? "Regenerate summary" : "Write summary"}</sl-button>
        <sl-button data-act="save"><sl-icon slot="prefix" name="cloud-upload"></sl-icon>Save to Drive again</sl-button>
        <sl-dropdown placement="bottom-end" hoist id="more">
          <sl-icon-button slot="trigger" name="three-dots" label="More actions"></sl-icon-button>
          <sl-menu>
            <sl-menu-item value="copy"><sl-icon slot="prefix" name="clipboard"></sl-icon>Copy notes</sl-menu-item>
            <sl-menu-item value="txt"><sl-icon slot="prefix" name="download"></sl-icon>Download transcript (.txt)</sl-menu-item>
            <sl-divider></sl-divider>
            <sl-menu-item value="delete"><sl-icon slot="prefix" name="trash"></sl-icon>Delete…</sl-menu-item>
          </sl-menu>
        </sl-dropdown>
      </div>
    </div>

    <sl-tab-group id="mtabs" style="margin-top:12px">
      <sl-tab slot="nav" panel="notes">Notes</sl-tab>
      <sl-tab slot="nav" panel="transcript">Transcript</sl-tab>
      <sl-tab slot="nav" panel="audio" ${m.audioTracks?.length ? "" : "disabled"}>Audio</sl-tab>
      <sl-tab slot="nav" panel="ask">Ask</sl-tab>

      <sl-tab-panel name="notes">${notesPanel(m)}</sl-tab-panel>
      <sl-tab-panel name="transcript">${transcriptPanel(m)}</sl-tab-panel>
      <sl-tab-panel name="audio">${audioPanel(m)}</sl-tab-panel>
      <sl-tab-panel name="ask">
        <div class="panel stack" id="chat">
          <p class="muted" style="margin:0">Questions are answered from this ${noun(m)}'s transcript only.</p>
          <form id="askf" class="row" style="gap:8px">
            <sl-input name="q" placeholder="What did we decide about pricing?" style="flex:1" label="Ask about this ${noun(m)}"></sl-input>
            <sl-button type="submit" variant="primary" style="align-self:flex-end">Ask</sl-button>
          </form>
        </div>
      </sl-tab-panel>
    </sl-tab-group>`;

  wireMeeting(m);
  const tabs = document.getElementById("mtabs");
  showTab(tabs, tabName);
  tabs.addEventListener("sl-tab-show", (e) => history.replaceState(null, "", `#/m/${m.id}/${e.detail.name}`));
  if (m.status === "processing" || ["recording", "transcribing"].includes(m.audioStatus)) refreshSoon();
}

function notesPanel(m) {
  const s = m.summary || {};
  const hasSummary = !!(s.tldr || s.headline);
  const people = (m.spoke || []).map((p) => p.name || p.speaker);
  return `<div class="cols">
    <div class="main stack">
      <section class="panel">
        <h2>Summary</h2>
        ${
          hasSummary
            ? `${s.headline ? `<p style="margin:0 0 6px;font-weight:600">${esc(s.headline)}</p>` : ""}<p style="margin:0">${esc(s.tldr || "")}</p>`
            : s.error
              ? `<p class="err" style="margin:0">The summary failed: ${esc(s.error)}</p>`
              : `<p class="muted" style="margin:0">No summary yet. ${
                  document.getElementById("ai-state")?.variant === "success"
                    ? "Use Write summary above."
                    : `Add an AI key in <a href="#/settings/ai">Settings › AI</a>, then use Write summary.`
                }</p>`
        }
      </section>
      ${
        s.key_points?.length || s.decisions?.length || s.open_questions?.length
          ? `<section class="panel">
              ${s.key_points?.length ? `<h2>Details</h2><ul class="points">${s.key_points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
              ${s.decisions?.length ? `<h3>Decisions</h3><ul class="points">${s.decisions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
              ${s.open_questions?.length ? `<h3>Open questions</h3><ul class="points">${s.open_questions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
              ${s.next_meeting ? `<p style="margin:12px 0 0"><b>Next meeting:</b> ${esc(s.next_meeting)}</p>` : ""}
            </section>`
          : ""
      }
      <section class="panel" id="actions">
        <h2>Next steps</h2>
        ${
          m.actionItems.length
            ? m.actionItems
                .map(
                  (a) => `<div class="ai-item ${a.done ? "done" : ""}" data-id="${a.id}">
                    <sl-checkbox ${a.done ? "checked" : ""}></sl-checkbox>
                    <div class="txt">${a.owner ? `<b>${esc(a.owner)}:</b> ` : ""}${esc(a.text)}${a.due ? ` <span class="muted">(due ${esc(a.due)})</span>` : ""}</div>
                  </div>`,
                )
                .join("")
            : `<p class="muted" style="margin:0 0 8px">None yet.</p>`
        }
        <form id="add-action" class="row" style="margin-top:10px">
          <sl-input name="text" size="small" placeholder="Add a next step…" style="flex:1"></sl-input>
          <sl-button size="small" type="submit">Add</sl-button>
        </form>
      </section>
    </div>
    <aside class="side stack">
      <section class="panel">
        <h2>People</h2>
        ${people.length ? people.map((p) => `<div>${esc(p)}</div>`).join("") : `<p class="muted" style="margin:0">No speakers captured.</p>`}
        ${
          m.silentInvitees?.length
            ? `<p class="muted small" style="margin:10px 0 0">Invited, not heard from: ${esc(
                m.silentInvitees.map((p) => `${p.name || p.email}${p.response === "declined" ? " (declined)" : ""}`).join(", "),
              )}</p>`
            : ""
        }
      </section>
      ${calendarPanel(m)}
      ${
        m.aiUsage?.calls
          ? `<section class="panel"><h2>AI cost</h2><p style="margin:0"><b>${usd(m.aiUsage.cost)}</b>${m.aiUsage.exact ? "" : ` <span class="muted small">est.</span>`}
              <span class="muted small">· ${m.aiUsage.calls} call${m.aiUsage.calls === 1 ? "" : "s"}</span></p>
              <a href="#/settings/usage" class="small">Spending history</a></section>`
          : ""
      }
    </aside>
  </div>`;
}

function calendarPanel(m) {
  const e = m.calendarEvent;
  const conf = {
    high: "matched by meeting link",
    confirmed: "confirmed by you",
    medium: `matched by ${m.matched_by || "calendar"}`,
    low: "matched by time only: worth checking",
  }[m.match_confidence];
  return `<section class="panel">
    <div class="row"><h2 style="margin:0">Calendar</h2><span class="spacer"></span>
      <sl-button size="small" id="pick-event">${e ? "Change" : "Link to an event"}</sl-button></div>
    ${
      e
        ? `<p style="margin:10px 0 2px;font-weight:600">${e.html_link ? `<a href="${esc(e.html_link)}" target="_blank" rel="noreferrer">${esc(e.title)}</a>` : esc(e.title)}</p>
           <p class="muted small" style="margin:0">${new Date(e.start_at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}${conf ? ` · ${esc(conf)}` : ""}</p>`
        : `<p class="muted small" style="margin:10px 0 0">Not matched to a calendar event. When two events overlap, ClearNote asks rather than guesses.</p>`
    }
    <div id="cal-picker"></div>
  </section>`;
}

function transcriptPanel(m) {
  const captions = m.segments
    .map(
      (sg) => `<div class="line">
        <span class="ts">${clock(sg.start_ms)}</span>
        <div>
          <div class="sp">${esc(sg.speaker)}<sl-icon-button name="pencil" label="Rename ${esc(sg.speaker)} everywhere" data-rename="${sg.id}" style="font-size:12px"></sl-icon-button></div>
          <div class="say" contenteditable="plaintext-only" data-text="${sg.id}">${esc(sg.text)}</div>
        </div>
      </div>`,
    )
    .join("");
  const audio = (m.mergedLines || [])
    .map(
      (l) => `<div class="line">
        <span class="ts">${clock(l.startMs)}</span>
        <div>
          <div class="sp">${esc(l.speaker)}${l.inferred ? ` <span class="muted small">(likely)</span>` : ""}${l.source === "captions" ? ` <span class="muted small">(from captions)</span>` : ""}</div>
          <div class="say">${esc(l.text)}</div>
        </div>
      </div>`,
    )
    .join("");
  return `<section class="panel">
    ${
      audio
        ? `<div class="row" style="margin-bottom:8px">
             <sl-radio-group id="txmode" value="audio" size="small">
               <sl-radio-button value="audio">Enhanced</sl-radio-button>
               <sl-radio-button value="captions">Captions only</sl-radio-button>
             </sl-radio-group>
             <span class="muted small" id="txhint">${esc(RECORD_TYPE[m.recordType] || "")}</span>
           </div>
           <div id="tx-audio">${audio}</div>
           <div id="tx-captions" class="tx" hidden>
             <p class="muted small">Click a line to fix it. Use the pencil to rename a speaker everywhere.</p>${captions}</div>`
        : `<p class="muted small" style="margin:0 0 6px">${
            m.segments.length ? "Click a line to fix it. Use the pencil to rename a speaker everywhere." : "No captions were captured."
          }</p><div class="tx">${captions}</div>`
    }
  </section>`;
}

function audioPanel(m) {
  if (!m.audioTracks?.length) return `<p class="muted">No audio was recorded for this ${noun(m)}.</p>`;
  const status = {
    recording: "Recording…",
    transcribing: "Transcribing the audio on this computer…",
    waiting: m.audioError || "Waiting to transcribe.",
    failed: `Transcription failed: ${m.audioError || "unknown error"}`,
  }[m.audioStatus];
  const saved = m.saved?.audio || {};
  const names = { tab: "Call (everyone else)", mic: "Your microphone" };
  return `<section class="panel stack">
    ${status ? `<sl-alert variant="${m.audioStatus === "failed" ? "danger" : "warning"}" open><sl-icon slot="icon" name="info-circle"></sl-icon>${esc(status)}</sl-alert>` : ""}
    ${m.audioTracks
      .filter((t) => t.bytes > 0)
      .map(
        (t) => `<div class="row">
          <span style="width:190px;font-weight:600">${names[t.track] || t.track}</span>
          <audio controls preload="none" src="${t.url}" style="flex:1 1 320px;height:36px"></audio>
        </div>`,
      )
      .join("")}
    ${
      Object.keys(saved).length
        ? `<p class="muted small" style="margin:0">Saved copies: ${Object.entries(saved)
            .map(([k, v]) => (v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(k)}</a>` : esc(`${k}: ${v.path}`)))
            .join(" · ")}</p>`
        : ""
    }
  </section>`;
}

function wireMeeting(m) {
  const title = document.getElementById("mtitle");
  title.onchange = () => api(`/meetings/${m.id}`, { method: "PATCH", body: JSON.stringify({ title: title.value }) });

  for (const b of view.querySelectorAll("[data-act]")) {
    b.addEventListener("click", async () => {
      b.loading = true;
      await runAction(b.dataset.act, m);
      b.loading = false;
    });
  }
  document.getElementById("more").addEventListener("sl-select", async (e) => {
    const v = e.detail.item.value;
    if (v === "copy") {
      const s = m.summary || {};
      const text = [
        m.title,
        new Date(m.started_at).toLocaleString(),
        "",
        s.tldr || "",
        ...(s.key_points || []).map((p) => `• ${p}`),
        s.decisions?.length ? `\nDecisions:\n${s.decisions.map((d) => `• ${d}`).join("\n")}` : "",
        m.actionItems.length
          ? `\nNext steps:\n${m.actionItems.map((a) => `• ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.due ? `, due ${a.due}` : ""}`).join("\n")}`
          : "",
      ]
        .filter((x) => x !== undefined)
        .join("\n");
      await navigator.clipboard.writeText(text);
      notify("Notes copied.", "success");
    } else runAction(v, m);
  });

  document.getElementById("actions").addEventListener("sl-change", async (e) => {
    const row = e.target.closest(".ai-item");
    if (!row) return;
    row.classList.toggle("done", e.target.checked);
    await api(`/action-items/${row.dataset.id}`, { method: "PATCH", body: JSON.stringify({ done: e.target.checked }) });
  });
  document.getElementById("add-action").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("sl-input");
    const text = input.value.trim();
    if (!text) return;
    await api(`/meetings/${m.id}/action-items`, { method: "POST", body: JSON.stringify({ text }) });
    renderMeeting(m.id, "notes");
  });

  document.getElementById("pick-event").onclick = () => openEventPicker(m);

  const mode = document.getElementById("txmode");
  if (mode) {
    mode.addEventListener("sl-change", () => {
      document.getElementById("tx-audio").hidden = mode.value !== "audio";
      document.getElementById("tx-captions").hidden = mode.value !== "captions";
    });
  }

  for (const tx of view.querySelectorAll(".tx")) {
    tx.addEventListener(
      "blur",
      async (e) => {
        const el = e.target.closest?.("[data-text]");
        if (!el) return;
        const seg = m.segments.find((sg) => String(sg.id) === el.dataset.text);
        const next = el.textContent.trim();
        if (!seg || next === seg.text) return;
        seg.text = next;
        await api(`/segments/${seg.id}`, { method: "PATCH", body: JSON.stringify({ text: next }) });
      },
      true,
    );
    tx.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-rename]");
      if (!btn) return;
      const seg = m.segments.find((sg) => String(sg.id) === btn.dataset.rename);
      if (!seg) return;
      const next = prompt(`Rename “${seg.speaker}” everywhere in this ${noun(m)}:`, seg.speaker);
      if (!next || next === seg.speaker) return;
      await api(`/segments/${seg.id}`, { method: "PATCH", body: JSON.stringify({ speaker: next, renameAll: true }) });
      renderMeeting(m.id, "transcript");
    });
  }

  const chat = document.getElementById("chat");
  const form = document.getElementById("askf");
  const history = [];
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("sl-input");
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    chat.insertBefore(bubble("user", q), form);
    const thinking = bubble("bot", "…");
    chat.insertBefore(thinking, form);
    try {
      const { text } = await api(`/meetings/${m.id}/ask`, { method: "POST", body: JSON.stringify({ question: q, history }) });
      thinking.textContent = text;
      history.push({ role: "user", content: q }, { role: "assistant", content: text });
    } catch (err) {
      thinking.textContent = err.message;
      thinking.classList.add("err");
    }
  });
}

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  return el;
}

async function openEventPicker(m) {
  const box = document.getElementById("cal-picker");
  box.innerHTML = loading("Loading events…");
  const { events, suggestion } = await api(`/meetings/${m.id}/match-candidates`);
  if (!events.length) {
    box.innerHTML = `<p class="muted small" style="margin-top:12px">No calendar events around this time. Connect Google in
      <a href="#/settings/connections">Settings › Connections</a>, or sync again.</p>`;
    return;
  }
  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
    <sl-radio-group id="ev" label="Which event was this?" value="${esc(m.calendar_event_id || "")}">
      ${events
        .map(
          (e) => `<sl-radio value="${esc(e.id)}">${esc(e.title)}${e.id === suggestion ? " (suggested)" : ""}
            <span class="muted small" style="display:block">${t(e.start_at)}–${t(e.end_at)} · ${e.attendees.length} invited</span></sl-radio>`,
        )
        .join("")}
    </sl-radio-group>
    <div class="row" style="margin-top:10px">
      <sl-button size="small" variant="primary" id="save-event">Link</sl-button>
      <sl-button size="small" id="clear-event">Not on the calendar</sl-button>
    </div>
  </div>`;
  document.getElementById("save-event").onclick = async () => {
    const v = document.getElementById("ev").value;
    if (!v) return;
    await api(`/meetings/${m.id}/match`, { method: "POST", body: JSON.stringify({ eventId: v, adoptTitle: !!m.title_is_generic }) });
    renderMeeting(m.id, "notes");
  };
  document.getElementById("clear-event").onclick = async () => {
    await api(`/meetings/${m.id}/match`, { method: "POST", body: JSON.stringify({ eventId: null }) });
    renderMeeting(m.id, "notes");
  };
}

// ---------------------------------------------------------------- settings

const NAME_TAGS = ["{title}", "{date}", "{time}", "{platform}", "{people}", "{part}", "{year}", "{month}", "{day}"];

async function showHook() {
  const box = document.getElementById("hookstate");
  if (!box) return;
  const st = await api("/webhook").catch(() => null);
  if (!st) return;
  box.innerHTML = !st.enabled ? tag("Off", "neutral") : st.failing ? tag(`${st.failing} failing`, "danger") : tag("On", "success");
  const res = document.getElementById("hookresult");
  if (res && !res.innerHTML && st.enabled)
    res.textContent = st.lastError && st.failing
      ? `Last error: ${st.lastError}`
      : st.lastSentAt
        ? `${st.sent} sent, last ${when(st.lastSentAt)}.`
        : "Nothing sent yet.";
}

function showSync(st) {
  const box = document.getElementById("syncstate");
  const last = document.getElementById("synclast");
  if (!box || !st) return;
  box.innerHTML = st.error ? tag("Problem", "danger") : st.enabled ? tag("On", "success") : tag("Off", "neutral");
  last.textContent = st.error
    ? st.error
    : st.lastAt
      ? `Last synced ${when(st.lastAt)}: ${st.sent} sent, ${st.received} received${st.removed ? `, ${st.removed} removed` : ""}.`
      : st.enabled
        ? "Not synced yet."
        : "Needs Google connected with Drive.";
}

// ------------------------------------------------------------------ updates

async function checkUpdates() {
  const bar = document.getElementById("updatebar");
  const u = await api("/update").catch(() => null);
  if (!u?.behind) return (bar.hidden = true);
  bar.hidden = false;
  bar.innerHTML = `<sl-alert variant="primary" open>
      <sl-icon slot="icon" name="arrow-up-circle"></sl-icon>
      <div class="row"><b style="flex:1">A ClearNote update is ready (${u.behind} change${u.behind === 1 ? "" : "s"}).</b>
        <sl-button size="small" id="upd-go" variant="primary" ${u.dirty ? "disabled" : ""}>Update now</sl-button></div>
      <ul class="points small" style="margin:6px 0 0">${u.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      ${u.dirty ? `<p class="small" style="margin:6px 0 0">This computer has its own changes to ClearNote's files, so it can't update with one click.</p>` : ""}
    </sl-alert>`;
  document.getElementById("upd-go").onclick = async (e) => {
    e.target.loading = true;
    const before = (await api("/version").catch(() => ({}))).commit;
    const r = await api("/update/apply", { method: "POST", body: "{}" }).catch((err) => ({ error: err.message }));
    if (!r.ok) {
      e.target.loading = false;
      return notify(r.error || "Update failed.", "danger");
    }
    bar.querySelector("b").textContent = "Updating and restarting ClearNote…";
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      const v = await api("/version").catch(() => null);
      if (v?.commit && v.commit !== before) return location.reload();
    }
    notify("ClearNote didn't come back after the update. Check ~/Library/Logs/clearnote.log.", "danger");
  };
}

// ------------------------------------------------------------------ model picker
// A list from the provider, with prices, instead of a typed model name, so a
// retired or mistyped model shows up here before it fails a summary.

const price = (m) =>
  m.inPerM == null ? "price not listed" : `$${+m.inPerM.toFixed(2)} in / $${+m.outPerM.toFixed(2)} out per million tokens`;

function modelPicker(key, provider, value, help) {
  return `<div class="stack" style="gap:6px" data-models="${provider}" data-help="${esc(help)}" data-value="${esc(value)}">
    ${provider === "openrouter" ? `<sl-input class="mfilter" size="small" placeholder="Filter the list: claude, gpt, gemini…" clearable></sl-input>` : ""}
    <sl-select data-key="${key}" label="Model" value="${esc(value)}">
      <sl-option value="${esc(value)}">${esc(value)}</sl-option>
    </sl-select>
    <div class="field-hint mhint">${esc(help)} Loading the models on offer…</div>
  </div>`;
}

async function loadModelPickers() {
  for (const box of view.querySelectorAll("[data-models]")) {
    const provider = box.dataset.models;
    const label = provider === "openrouter" ? "OpenRouter" : "Anthropic";
    const select = box.querySelector("sl-select");
    const hint = box.querySelector(".mhint");
    const help = box.dataset.help;
    const r = await api(`/ai/models?provider=${provider}`).catch((err) => ({ error: err.message, models: [] }));
    if (r.error) {
      hint.innerHTML = `${esc(help)} <span style="color:var(--sl-color-warning-600)">Couldn't load ${label}'s list: ${esc(r.error)}</span>`;
      continue;
    }
    // The saved choice, from the page as rendered: the select's own value may
    // not be settled yet while its options are still being upgraded.
    const current = box.dataset.value;
    let picked = current;
    select.addEventListener("sl-change", () => (picked = select.value));
    const fill = (filter = "") => {
      const f = filter.toLowerCase();
      const keep = r.models.filter((m) => !f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f) || m.id === picked);
      const retired = r.models.some((m) => m.id === current) ? "" : `<sl-option value="${esc(current)}">${esc(current)} (no longer offered)</sl-option>`;
      select.innerHTML =
        retired + keep.map((m) => `<sl-option value="${esc(m.id)}">${esc(m.name)}<small slot="suffix" class="muted">${price(m)}</small></sl-option>`).join("");
      setTimeout(() => (select.value = picked));
    };
    fill();
    const showHint = () => {
      const m = r.models.find((x) => x.id === picked);
      hint.innerHTML = m
        ? `${esc(help)} <code>${esc(m.id)}</code>: ${price(m)}.`
        : `<span style="color:var(--sl-color-danger-600)">${esc(picked)} isn't offered by ${label} any more. Pick another model, or summaries will fail.</span>`;
    };
    setTimeout(showHint);
    select.addEventListener("sl-change", () => setTimeout(showHint));
    const filter = box.querySelector(".mfilter");
    if (filter) filter.addEventListener("sl-input", () => fill(filter.value));
  }
}

function txSetupRow(audio) {
  if (!audio) return `<span class="muted">Couldn't check this Mac's transcription setup.</span>`;
  const st = audio.setup || {};
  if (st.running) return `<sl-spinner></sl-spinner><span>${esc(st.step)}${st.pct != null ? ` ${st.pct}%` : ""}</span>`;
  if (audio.ready)
    return `${tag("Set up", "success")}<span>Transcribes on this Mac with whisper.cpp (${esc(audio.model)}). Nothing is sent anywhere.</span>`;
  return `${tag("Not set up", "neutral")}
    <span style="flex:1 1 260px">Needs whisper.cpp, ffmpeg and a speech model (about ${audio.downloadMb} MB download). Missing: ${esc(audio.missing.join(", "))}.
      ${audio.homebrew ? "" : `Install Homebrew from brew.sh first.`}
      ${st.error ? `<br><span style="color:var(--sl-color-danger-600)">${esc(st.error)}</span>` : ""}</span>
    <sl-button id="txsetup-go" ${audio.homebrew ? "" : "disabled"}>Set up on this Mac</sl-button>`;
}

function wireTxSetup() {
  const box = document.getElementById("txsetup");
  if (!box) return;
  const poll = async () => {
    const a = await api("/audio/status").catch(() => null);
    if (!document.body.contains(box)) return;
    box.innerHTML = txSetupRow(a);
    wireTxSetup(); // polls again while setup is running
  };
  const go = document.getElementById("txsetup-go");
  if (go) go.onclick = async () => {
    go.loading = true;
    await api("/audio/setup", { method: "POST", body: "{}" });
    setTimeout(poll, 500);
  };
  if (box.querySelector("sl-spinner")) setTimeout(poll, 1500);
}

async function renderSettings(tabName = "general") {
  const flash = new URLSearchParams(location.hash.split("?")[1] || "").get("google");
  if (flash) tabName = "connections";
  view.innerHTML = loading("Loading settings…");
  const [cfg, status, audio, sync, ver] = await Promise.all([
    api("/settings"),
    api("/google/status"),
    api("/audio/status").catch(() => null),
    api("/sync").catch(() => null),
    api("/version").catch(() => null),
  ]);
  const syncDevice = sync?.device;
  const v = cfg.values;
  const sec = cfg.secrets;
  const locked = new Set(cfg.locked);
  const dis = (k) => (locked.has(k) ? "disabled" : "");
  const lockHelp = (k, help = "") => (locked.has(k) ? "Set by an environment variable." : help);

  const sw = (k, label, hint = "") => `<div class="setting"><span>${label}${hint ? `<span class="hint">${hint}</span>` : ""}</span>
    <sl-switch data-key="${k}" ${v[k] ? "checked" : ""} ${dis(k)}></sl-switch></div>`;
  const input = (k, label, placeholder = "", help = "") =>
    `<sl-input data-key="${k}" label="${esc(label)}" value="${esc(v[k] ?? "")}" placeholder="${esc(placeholder)}" help-text="${esc(lockHelp(k, help))}" ${dis(k)}></sl-input>`;
  const secret = (k, label, placeholder) => `<div class="row" style="align-items:flex-end">
    <sl-input data-secret="${k}" type="password" label="${esc(label)}" autocomplete="off" style="flex:1"
      placeholder="${sec[k].set ? `Saved (${esc(sec[k].hint)}). Paste a new one to replace it.` : esc(placeholder)}"
      help-text="${esc(lockHelp(k))}" ${dis(k)}></sl-input>
    ${sec[k].set && !locked.has(k) ? `<sl-button data-clear="${k}">Remove</sl-button>` : ""}
  </div>`;
  const redirect = `${location.origin}/api/google/callback`;
  const driveNeeded = (v.saveNotes || v.saveAudio === "drive") && !status.drive;

  view.innerHTML = `
    <h1>Settings</h1>
    <p class="sub">Stored only on this computer, in <code>${esc(cfg.file)}</code>, readable only by you. Keys are never shown again after saving.</p>
    ${
      flash
        ? `<sl-alert variant="${flash === "connected" ? "success" : "danger"}" open closable style="margin-bottom:16px">
             <sl-icon slot="icon" name="${flash === "connected" ? "check2-circle" : "exclamation-octagon"}"></sl-icon>
             ${flash === "connected" ? "Google connected." : `Could not connect Google: ${esc(flash)}`}</sl-alert>`
        : ""
    }
    <div class="settings">
      <sl-tab-group id="stabs" placement="start">
        <sl-tab slot="nav" panel="general">General</sl-tab>
        <sl-tab slot="nav" panel="rules">Rules</sl-tab>
        <sl-tab slot="nav" panel="recording">Recording</sl-tab>
        <sl-tab slot="nav" panel="ai">AI summaries</sl-tab>
        <sl-tab slot="nav" panel="usage">Usage</sl-tab>
        <sl-tab slot="nav" panel="saving">Saving &amp; names</sl-tab>
        <sl-tab slot="nav" panel="connections">Connections</sl-tab>
        <sl-tab slot="nav" panel="advanced">Advanced</sl-tab>

        <sl-tab-panel name="general"><div class="panel stack">
          <h2>General</h2>
          ${input("displayName", "Your name", "e.g. Ada Lovelace", "Captions call you “You”. This puts your name in transcripts and notes.")}
          ${sw("autoCapture", "Capture every call automatically", "Captions start when you join a Meet, Zoom or Teams call in Chrome.")}
          ${sw("showActionItems", "Show Action items in the menu", "Next steps still appear on each capture's page either way.")}
          ${sw("hideCaptions", "Hide the platform's caption overlay", "Captions stay on so ClearNote can read them, but off your screen.")}
          <p class="field-hint" style="margin:0">What appears on a call's page, and when ClearNote captures at all, is set per situation in
            <a href="#/settings/rules">Rules</a>. The ClearNote icon in Chrome's toolbar always shows the state without blinking:
            normal colours while captions are captured, muted red while audio is recorded.</p>
        </div></sl-tab-panel>

        <sl-tab-panel name="rules"><div id="rules" class="stack">${loading("Loading rules…")}</div></sl-tab-panel>

        <sl-tab-panel name="recording"><div class="panel stack">
          <h2>Recording and transcription</h2>
          ${sw("oneClickRecord", "Start straight away", "Clicking the ClearNote icon starts the ticked choices at once, without the Start button. Chrome requires that click either way; recording can't start on its own.")}
          ${sw("recordMic", "Record my microphone with the call", "Your voice on its own track, so the transcript knows which lines are yours. Chrome asks permission once, from the extension's own settings.")}
          <h3>Improve transcripts with audio</h3>
          <p class="muted" style="margin:0">Captions are the quick, free transcript and need nothing extra. When you also record a call's audio, ClearNote can transcribe it
            on this Mac and combine it with the captions: more accurate words, with speaker names still taken from the captions.
            Audio recorded on a page with no captions is always transcribed when this Mac is set up.</p>
          <sl-select data-key="enhanceTranscripts" label="When a call has captions and audio" value="${esc(v.enhanceTranscripts)}">
            <sl-option value="off">Keep the audio as files; captions are the transcript</sl-option>
            <sl-option value="local">Improve the transcript using the audio, on this Mac</sl-option>
          </sl-select>
          <div class="row" id="txsetup">${txSetupRow(audio)}</div>
          <p class="field-hint" style="margin:0">To record: click the ClearNote icon in Chrome's toolbar, check the ticked choices, then Start. Or press Option+Shift+R.
            The icon itself shows the state: grey when idle, normal while capturing captions, muted red while recording audio.</p>
        </div></sl-tab-panel>

        <sl-tab-panel name="ai"><div class="panel stack">
          <div class="row"><h2 style="margin:0">AI summaries</h2>${tag(cfg.ai.configured ? `On: ${cfg.ai.order.join(", then ")}` : "Off", cfg.ai.configured ? "success" : "neutral")}</div>
          <p class="muted" style="margin:0">Summaries, next steps and questions about each capture. Separate from transcription, which never uses these. Add a key for either provider. With both, one is tried first and the other if it fails.</p>
          <sl-select data-key="aiPrimary" label="Use first" value="${esc(v.aiPrimary)}">
            <sl-option value="anthropic">Anthropic</sl-option>
            <sl-option value="openrouter">OpenRouter</sl-option>
          </sl-select>
          ${sw("aiBackup", "If it fails, try the other provider")}
          <h3>Anthropic</h3>
          ${secret("anthropicKey", "API key", "sk-ant-…")}
          ${modelPicker("anthropicModel", "anthropic", v.anthropicModel, "Create a key at console.anthropic.com.")}
          <div class="row"><sl-button data-test="anthropic">Test Anthropic</sl-button><span id="test-anthropic" class="small"></span></div>
          <h3>OpenRouter</h3>
          ${secret("openrouterKey", "API key", "sk-or-…")}
          ${modelPicker("openrouterModel", "openrouter", v.openrouterModel, "Create a key at openrouter.ai.")}
          <div class="row"><sl-button data-test="openrouter">Test OpenRouter</sl-button><span id="test-openrouter" class="small"></span></div>
        </div></sl-tab-panel>

        <sl-tab-panel name="usage"><div id="usage" class="stack">${loading("Loading spending…")}</div></sl-tab-panel>

        <sl-tab-panel name="saving"><div class="stack">
          <div class="panel stack">
            <h2>Where captures are saved</h2>
            <p class="muted" style="margin:0">Both update automatically when you fix the transcript, add a summary or re-transcribe.</p>
            ${driveNeeded ? `<sl-alert variant="warning" open><sl-icon slot="icon" name="exclamation-triangle"></sl-icon>Saving to Drive needs Google ${status.connected ? "reconnected once to add Drive access" : "connected"}: see <a href="#/settings/connections">Connections</a>.</sl-alert>` : ""}
            ${sw("saveNotes", "Save notes to Google Drive", "One Google Doc per capture, like Gemini's meeting notes, with a notes tab and a transcript tab. Calls and other captures share the folder.")}
            <div data-show="saveNotes" class="stack">
              ${input("notesFolderName", "Notes folder name", "ClearNote Meeting Notes", "Used when ClearNote creates the folder. Afterwards rename or move it in Drive; ClearNote keeps using it.")}
              ${v.notesFolderId ? `<a href="https://drive.google.com/drive/folders/${esc(v.notesFolderId)}" target="_blank" rel="noreferrer">Open the notes folder in Drive</a>` : ""}
            </div>
            <sl-radio-group data-key="saveAudio" label="Save audio files" value="${esc(v.saveAudio)}" help-text="Three MP3s per recording: everything mixed together, the tab's sound alone, and your microphone alone.">
              <sl-radio value="off">Don't save</sl-radio>
              <sl-radio value="drive">To Google Drive</sl-radio>
              <sl-radio value="local">To a folder on this computer</sl-radio>
            </sl-radio-group>
            <div data-show-audio="drive" class="stack">
              ${input("audioFolderName", "Drive audio folder name", "ClearNote Audio", "Used when ClearNote creates the folder.")}
              ${v.audioFolderId ? `<a href="https://drive.google.com/drive/folders/${esc(v.audioFolderId)}" target="_blank" rel="noreferrer">Open the audio folder in Drive</a>` : ""}
            </div>
            <div data-show-audio="local" class="stack">
              <div class="row">
                <input type="hidden" data-key="audioLocalPath" value="${esc(v.audioLocalPath || "")}" />
                <span class="pathbox" id="audioPathShow">${esc(v.audioLocalPath || "~/ClearNote Audio")}${v.audioLocalPath ? "" : " (default)"}</span>
                <sl-button id="chooseFolder"><sl-icon slot="prefix" name="folder2-open"></sl-icon>Choose folder…</sl-button>
              </div>
              <p class="field-hint" style="margin:0">A folder synced by Google Drive, Dropbox or iCloud works too.</p>
            </div>
          </div>

          <div class="panel stack">
            <h2>File names</h2>
            <p class="muted" style="margin:0">Click a field, then a tag to add it. Calls and other captures (YouTube, websites) are named separately; examples use your latest of each.</p>
            <div class="tags">${NAME_TAGS.map((t) => `<sl-button size="small" pill data-tag="${t}">${t}</sl-button>`).join("")}</div>
            <div class="names">
              <h3 class="names-head">Calls (Meet, Zoom, Teams)</h3>
              <label for="n-notes">Notes Doc</label>
              <sl-input id="n-notes" data-key="notesDocName" data-name value="${esc(v.notesDocName)}"></sl-input>
              <span class="example" id="ex-notes"></span>
              <label for="n-audio">Audio files</label>
              <sl-input id="n-audio" data-key="audioFileName" data-name value="${esc(v.audioFileName)}"></sl-input>
              <span class="example" id="ex-audio"></span>
              <h3 class="names-head">Other captures (YouTube, websites)</h3>
              <label for="n-notes2">Notes Doc</label>
              <sl-input id="n-notes2" data-key="notesDocNameOther" data-name value="${esc(v.notesDocNameOther)}"></sl-input>
              <span class="example" id="ex-notes2"></span>
              <label for="n-audio2">Audio files</label>
              <sl-input id="n-audio2" data-key="audioFileNameOther" data-name value="${esc(v.audioFileNameOther)}"></sl-input>
              <span class="example" id="ex-audio2"></span>
              <h3 class="names-head">Both</h3>
              <label for="n-tab1">Doc tab: notes</label>
              <sl-input id="n-tab1" data-key="tabNotesName" value="${esc(v.tabNotesName)}"></sl-input>
              <label for="n-tab2">Doc tab: transcript</label>
              <sl-input id="n-tab2" data-key="tabTranscriptName" value="${esc(v.tabTranscriptName)}"></sl-input>
            </div>
            <div class="parts">
              <sl-input data-key="partMixed" data-name label="{part} for everyone" value="${esc(v.partMixed)}"></sl-input>
              <sl-input data-key="partCall" data-name label="{part} for the tab's sound" value="${esc(v.partCall)}"></sl-input>
              <sl-input data-key="partMic" data-name label="{part} for your mic" value="${esc(v.partMic)}"></sl-input>
            </div>
            <p class="field-hint" style="margin:0">Renaming a tab applies to new notes; existing Docs get the new tab names the next time they're saved.</p>
          </div>
        </div></sl-tab-panel>

        <sl-tab-panel name="connections"><div class="stack">
          <div class="panel stack">
            <div class="row"><h2 style="margin:0">Google</h2>${tag(
              status.connected ? (status.drive ? "Connected" : "Reconnect for Drive") : status.configured ? "Ready to connect" : "Not set up",
              status.connected && status.drive ? "success" : status.connected || status.configured ? "warning" : "neutral",
            )}</div>
            ${
              status.connected
                ? `<p style="margin:0">Connected as <b>${esc(status.email || "unknown")}</b> · ${status.eventCount} events · last synced ${status.lastSyncAt ? when(status.lastSyncAt) : "never"}</p>
                   <ul class="points muted" style="margin:0"><li>Calendar: read only</li><li>Drive: only the files ClearNote creates</li></ul>
                   ${status.drive ? "" : `<sl-alert variant="warning" open><sl-icon slot="icon" name="exclamation-triangle"></sl-icon>Connected for the calendar only. Reconnect once so ClearNote can save to Drive.</sl-alert>
                     <sl-button variant="primary" href="/api/google/connect">Reconnect Google</sl-button>`}
                   <div id="calendars"></div>
                   <div class="row"><sl-button id="sync"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon>Sync calendar now</sl-button>
                     <sl-button id="disconnect" variant="danger" outline>Disconnect</sl-button></div>`
                : `<p class="muted" style="margin:0">Reads your calendar to match each call to its event and invitees (it never changes your calendar),
                     and saves notes and audio to Drive. In Drive, ClearNote can only see the files it creates.</p>
                   ${
                     status.configured
                       ? `<sl-button variant="primary" href="/api/google/connect"><sl-icon slot="prefix" name="google"></sl-icon>Connect Google</sl-button>`
                       : `<sl-details summary="One-time setup (about five minutes)" open>
                            <p class="field-hint">Google asks every app that reads a calendar to have its own sign-in setup. Make one once, in your own Google account, then paste two values below.</p>
                            <ol class="steps">
                              <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud</a> and create a project.</li>
                              <li>Enable <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer">Google Calendar API</a>,
                                <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a> and
                                <a href="https://console.cloud.google.com/apis/library/docs.googleapis.com" target="_blank" rel="noreferrer">Google Docs API</a>.</li>
                              <li>In <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>, choose <b>Internal</b> for a Google Workspace account. With personal Gmail choose <b>External</b>, add yourself as a test user, then <b>Publish app</b>, or you'll be signed out every 7 days.</li>
                              <li>Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Clients</a>, create a <b>Web application</b> client with this redirect URI:
                                <div class="row" style="margin-top:6px"><code class="pathbox">${esc(redirect)}</code><sl-copy-button value="${esc(redirect)}"></sl-copy-button></div></li>
                              <li>Paste the client ID and secret below, Save, then Connect.</li>
                            </ol>
                          </sl-details>`
                   }
                   ${input("googleClientId", "Client ID", "….apps.googleusercontent.com")}
                   ${secret("googleClientSecret", "Client secret", "GOCSPX-…")}`
            }
          </div>
          ${status.connected ? `<div class="panel" id="upcoming"></div>` : ""}
          <div class="panel stack">
            <div class="row"><h2 style="margin:0">Send finished captures to another app</h2><span id="hookstate"></span></div>
            <p class="muted" style="margin:0">When a capture is finished, ClearNote sends it (title, source, people, summary, next steps and the full transcript) as JSON to this
              address: your own notes system, an automation tool such as Zapier or n8n, or a script. Changes later on, such as a regenerated summary,
              are sent again. Only the computer that recorded a capture sends it.</p>
            ${input("webhookUrl", "Address", "https://example.com/clearnote", "Must accept a POST with a JSON body. Leave empty to turn this off.")}
            ${secret("webhookSecret", "Signing secret (optional)", "A long random string the receiver also knows")}
            <p class="field-hint" style="margin:0">With a secret, each request carries <code>X-ClearNote-Signature: sha256=…</code>, an HMAC-SHA256 of the body, so the receiver can check it came from you.</p>
            <div class="row"><sl-button id="hooktest">Send a test</sl-button><sl-button id="hookpast">Also send past captures</sl-button><span id="hookresult" class="small"></span></div>
          </div>
          <div class="panel stack">
            <div class="row"><h2 style="margin:0">Your other computers</h2><span id="syncstate"></span></div>
            <p class="muted" style="margin:0">Captures from any of your computers show up on all of them. Each one shares what it captured
              (transcript, summary, next steps, people; not audio) through a "ClearNote sync" folder in your Google Drive. Install ClearNote on the other
              computer, paste the same Google client ID and secret, and connect the same Google account.</p>
            ${sw("syncDrive", "Share captures with my other computers")}
            ${input("deviceName", "This computer's name", syncDevice || "", "Shown on captures made here when you look at them on another computer.")}
            <div class="row"><sl-button id="syncnow"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon>Sync now</sl-button><span id="synclast" class="muted small"></span></div>
          </div>
        </div></sl-tab-panel>

        <sl-tab-panel name="advanced"><div class="panel stack">
          <h2>Advanced</h2>
          ${sw("debug", "Log capture details to the call page's console", "For fixing a call platform that stopped capturing.")}
          <p style="margin:0"><b>Settings file:</b> <code>${esc(cfg.file)}</code></p>
          <p class="muted" style="margin:0">The extension's server address and sync token are set in the extension's own options (right-click the ClearNote icon › Options).</p>
          <h3>Updates</h3>
          <p class="muted" style="margin:0">ClearNote checks <code>${esc(ver?.remote || "its GitHub copy")}</code> for new versions every few hours. Updating restarts the
            server; the extension reloads itself within ten minutes, once no call is open.</p>
          <div class="row"><span>Version <code>${esc(ver?.commit || "unknown")}</code></span>
            <sl-button id="updcheck" size="small">Check now</sl-button><span id="updresult" class="small"></span></div>
        </div></sl-tab-panel>
      </sl-tab-group>
    </div>
    <div class="savebar"><span class="muted small" id="dirty"></span><sl-button variant="primary" id="save-settings">Save</sl-button></div>`;

  // --- wiring
  const tabs = document.getElementById("stabs");
  showTab(tabs, tabName);
  tabs.addEventListener("sl-tab-show", (e) => {
    history.replaceState(null, "", `#/settings/${e.detail.name}`);
    if (e.detail.name === "connections" && status.connected) loadConnections();
    if (e.detail.name === "usage") loadUsage();
    if (e.detail.name === "rules") loadRules();
    toggleSavebar(e.detail.name);
  });
  if (tabName === "rules") loadRules();
  toggleSavebar(tabName);
  if (tabName === "connections" && status.connected) loadConnections();
  if (tabName === "usage") loadUsage();

  const read = (el) => (el.tagName === "SL-SWITCH" || el.tagName === "SL-CHECKBOX" ? el.checked : el.value);
  const collect = () => {
    const patch = {};
    for (const el of view.querySelectorAll("[data-key]:not([disabled])")) patch[el.dataset.key] = read(el);
    for (const el of view.querySelectorAll("[data-secret]:not([disabled])")) if (el.value.trim()) patch[el.dataset.secret] = el.value.trim();
    const cals = [...view.querySelectorAll("[data-cal]")];
    if (cals.length) {
      const picked = cals.filter((c) => c.checked).map((c) => c.dataset.cal);
      patch.calendarIds = picked.length ? picked : ["primary"];
    }
    return patch;
  };
  const save = (patch = collect()) =>
    api("/settings", { method: "PATCH", body: JSON.stringify(patch) }).then((r) => {
      applyMenu(r.values);
      return r;
    });

  const dirty = document.getElementById("dirty");
  const markDirty = () => (dirty.textContent = "Unsaved changes");
  view.addEventListener("sl-change", markDirty);
  view.addEventListener("sl-input", markDirty);

  document.getElementById("save-settings").onclick = async (e) => {
    e.target.loading = true;
    try {
      await save();
      notify("Settings saved.", "success");
      renderSettings(tabs.querySelector("sl-tab[active]")?.panel || tabName);
    } catch (err) {
      notify(err.message, "danger");
      e.target.loading = false;
    }
  };
  for (const b of view.querySelectorAll("[data-clear]")) {
    b.onclick = async () => {
      await save({ [b.dataset.clear]: "" });
      renderSettings(tabs.querySelector("sl-tab[active]")?.panel || tabName);
    };
  }
  wireTxSetup();
  loadModelPickers();
  showHook();
  document.getElementById("hooktest").onclick = async (e) => {
    e.target.loading = true;
    await save();
    const r = await api("/webhook/test", { method: "POST", body: "{}" }).catch((err) => ({ ok: false, error: err.message }));
    e.target.loading = false;
    document.getElementById("hookresult").innerHTML = r.ok ? tag(`Received (HTTP ${r.status})`, "success") : tag(`Failed: ${r.error}`, "danger");
  };
  document.getElementById("hookpast").onclick = async (e) => {
    e.target.loading = true;
    await save();
    await api("/webhook/send-past", { method: "POST", body: "{}" });
    e.target.loading = false;
    document.getElementById("hookresult").innerHTML = tag("Sending every past capture in the background", "primary");
    setTimeout(showHook, 5000);
  };
  showSync(sync);
  document.getElementById("syncnow").onclick = async (e) => {
    e.target.loading = true;
    await save();
    showSync(await api("/sync/now", { method: "POST", body: "{}" }).catch((err) => ({ error: err.message })));
    e.target.loading = false;
  };
  document.getElementById("updcheck").onclick = async (e) => {
    e.target.loading = true;
    const u = await api("/update/check", { method: "POST", body: "{}" }).catch((err) => ({ error: err.message }));
    e.target.loading = false;
    document.getElementById("updresult").innerHTML = u.error
      ? tag(`Couldn't check: ${u.error}`, "danger")
      : u.behind
        ? tag(`${u.behind} new change${u.behind === 1 ? "" : "s"}: use the banner at the top to update`, "primary")
        : tag("Up to date", "success");
    checkUpdates();
  };
  for (const b of view.querySelectorAll("[data-test]")) {
    b.onclick = async () => {
      const out = document.getElementById(`test-${b.dataset.test}`);
      b.loading = true;
      await save();
      const r = await api("/ai/test", { method: "POST", body: JSON.stringify({ provider: b.dataset.test }) });
      b.loading = false;
      out.innerHTML = r.ok ? tag(`Works (${r.model})`, "success") : tag(`Failed: ${r.error}`, "danger");
    };
  }

  // Show only the fields that apply to the current choices.
  const toggle = () => {
    const notesOn = view.querySelector('[data-key="saveNotes"]')?.checked;
    const audioTo = view.querySelector('[data-key="saveAudio"]')?.value;
    for (const el of view.querySelectorAll("[data-show=saveNotes]")) el.hidden = !notesOn;
    for (const el of view.querySelectorAll("[data-show-audio]")) el.hidden = el.dataset.showAudio !== audioTo;
  };
  view.addEventListener("sl-change", toggle);
  customElements.whenDefined("sl-switch").then(toggle);
  toggle();

  document.getElementById("chooseFolder").onclick = () =>
    chooseFolder(view.querySelector('[data-key="audioLocalPath"]').value || "~", (picked) => {
      view.querySelector('[data-key="audioLocalPath"]').value = picked;
      document.getElementById("audioPathShow").textContent = picked;
      markDirty();
    });

  // Name templates: tags go into the last name field you clicked; examples update as you type.
  let lastName = document.getElementById("n-notes");
  for (const el of view.querySelectorAll("[data-name]")) el.addEventListener("sl-focus", () => (lastName = el));
  for (const b of view.querySelectorAll("[data-tag]")) {
    b.onclick = () => {
      const cur = lastName.value || "";
      lastName.value = `${cur}${cur && !cur.endsWith(" ") ? " " : ""}${b.dataset.tag}`;
      lastName.focus();
      markDirty();
      preview();
    };
  }
  let pv;
  const preview = () => {
    clearTimeout(pv);
    pv = setTimeout(async () => {
      const body = {};
      for (const el of view.querySelectorAll("[data-name]")) body[el.dataset.key] = el.value;
      try {
        const r = await api("/names/preview", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("ex-notes").textContent = `Example: ${r.call.notes}`;
        document.getElementById("ex-audio").textContent = `Example: ${r.call.audio.mixed}, ${r.call.audio.call}, ${r.call.audio.mic}`;
        document.getElementById("ex-notes2").textContent = `Example: ${r.other.notes}`;
        document.getElementById("ex-audio2").textContent = `Example: ${r.other.audio.mixed}, ${r.other.audio.call}, ${r.other.audio.mic}`;
      } catch {
        /* preview is a nicety */
      }
    }, 250);
  };
  for (const el of view.querySelectorAll("[data-name]")) el.addEventListener("sl-input", preview);
  preview();

  if (status.connected) {
    document.getElementById("sync").onclick = async (e) => {
      e.target.loading = true;
      await api("/google/sync", { method: "POST" });
      notify("Calendar synced.", "success");
      renderSettings("connections");
    };
    document.getElementById("disconnect").onclick = async () => {
      if (!confirm("Disconnect Google? Cached events and calendar matches are removed. Files already in Drive stay there.")) return;
      await api("/google/disconnect", { method: "POST" });
      renderSettings("connections");
    };
  }
}

// --------------------------------------------------------------- rules tab

const SITE_LABELS = {
  calls: "Any call (Meet, Zoom, Teams)",
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  youtube: "YouTube",
  domains: "Websites I list",
  any: "Anywhere",
};
const HOST_LABELS = { any: "Anyone hosts", me: "I host", others: "Someone else hosts", unknown: "Not on my calendar" };
const CAPTION_LABELS = { auto: "Capture automatically", click: "Ticked when I open ClearNote", off: "Off (unticked)" };
const PANEL_LABELS = { full: "Full panel", compact: "Small label", hidden: "Nothing" };
const AUDIO_LABELS = { click: "Ticked when I open ClearNote", off: "Unticked" };
const CALL_SITES = ["calls", "meet", "zoom", "teams"];

let rulesDraft = null;

/** Rules and Usage have their own buttons; hide the page-wide Save there. */
function toggleSavebar(tab) {
  const bar = document.querySelector(".savebar");
  if (bar) bar.hidden = tab === "rules" || tab === "usage";
}

async function loadRules() {
  const box = document.getElementById("rules");
  if (!box) return;
  if (!rulesDraft) rulesDraft = (await api("/rules")).rules;
  const opts = (map, val) => Object.entries(map).map(([k, l]) => `<sl-option value="${k}" ${k === val ? "selected" : ""}>${esc(l)}</sl-option>`).join("");
  box.innerHTML = `
    <div class="panel stack">
      <div class="row"><h2 style="margin:0">Rules</h2><span class="spacer"></span>
        <sl-button size="small" id="rules-reset">Reset to defaults</sl-button>
        <sl-button size="small" id="rules-add"><sl-icon slot="prefix" name="plus-lg"></sl-icon>Add rule</sl-button></div>
      <p class="muted" style="margin:0">What ClearNote does in each situation. Checked from the top; the first rule that fits decides.
        Who hosts a call comes from your calendar: the event with that call's link says who organised it.</p>
    </div>
    ${rulesDraft
      .map((r, i) => {
        const isCall = CALL_SITES.includes(r.match.site);
        return `<div class="panel stack rule" data-i="${i}">
          <div class="row">
            <span class="muted small" style="width:24px">${i + 1}.</span>
            <sl-input size="small" data-f="name" value="${esc(r.name)}" style="flex:1" aria-label="Rule name"></sl-input>
            <sl-icon-button name="arrow-up" label="Move up" data-move="-1" ${i === 0 ? "disabled" : ""}></sl-icon-button>
            <sl-icon-button name="arrow-down" label="Move down" data-move="1" ${i === rulesDraft.length - 1 ? "disabled" : ""}></sl-icon-button>
            <sl-icon-button name="trash" label="Delete rule" data-del></sl-icon-button>
          </div>
          <div class="rulegrid">
            <sl-select size="small" label="Where" data-f="site" value="${esc(r.match.site)}" hoist>${opts(SITE_LABELS, r.match.site)}</sl-select>
            ${
              r.match.site === "domains"
                ? `<sl-input size="small" label="Websites (comma-separated)" data-f="domains" value="${esc(r.match.domains.join(", "))}" placeholder="webinar.example.com, events.acme.com"></sl-input>`
                : `<sl-select size="small" label="Host" data-f="host" value="${esc(r.match.host)}" ${isCall ? "" : "disabled"} hoist help-text="${isCall ? "" : "Only applies to calls"}">${opts(HOST_LABELS, r.match.host)}</sl-select>`
            }
            <sl-select size="small" label="Captions" data-f="captions" value="${esc(r.actions.captions)}" hoist>${opts(CAPTION_LABELS, r.actions.captions)}</sl-select>
            <sl-select size="small" label="On the page" data-f="panel" value="${esc(r.actions.panel)}" hoist>${opts(PANEL_LABELS, r.actions.panel)}</sl-select>
            <sl-select size="small" label="Audio" data-f="audio" value="${esc(r.actions.audio)}" hoist>${opts(AUDIO_LABELS, r.actions.audio)}</sl-select>
          </div>
          <div class="row" style="gap:18px">
            <sl-switch size="small" data-f="summary" ${r.actions.summary ? "checked" : ""}>Summary</sl-switch>
            <sl-switch size="small" data-f="saveNotes" ${r.actions.saveNotes ? "checked" : ""}>Save notes</sl-switch>
            <sl-switch size="small" data-f="saveAudio" ${r.actions.saveAudio ? "checked" : ""}>Save audio</sl-switch>
          </div>
        </div>`;
      })
      .join("")}
    <div class="row"><span class="spacer"></span><span class="muted small" id="rules-dirty"></span>
      <sl-button variant="primary" id="rules-save">Save rules</sl-button></div>`;

  const read = () => {
    for (const card of box.querySelectorAll(".rule")) {
      const r = rulesDraft[Number(card.dataset.i)];
      const f = (k) => card.querySelector(`[data-f="${k}"]`);
      r.name = f("name").value;
      r.match.site = f("site").value;
      if (f("domains")) r.match.domains = f("domains").value.split(/[,\s]+/).filter(Boolean);
      if (f("host")) r.match.host = f("host").value;
      for (const k of ["captions", "panel", "audio"]) r.actions[k] = f(k).value;
      for (const k of ["summary", "saveNotes", "saveAudio"]) r.actions[k] = f(k).checked;
    }
  };
  const dirty = () => (document.getElementById("rules-dirty").textContent = "Unsaved changes");
  box.addEventListener("sl-input", dirty);
  box.addEventListener("sl-change", (e) => {
    dirty();
    // Changing "Where" can swap the host field for a websites field.
    if (e.target.dataset.f === "site") {
      read();
      loadRules();
    }
  });
  for (const b of box.querySelectorAll("[data-move]")) {
    b.onclick = () => {
      read();
      const i = Number(b.closest(".rule").dataset.i);
      const j = i + Number(b.dataset.move);
      [rulesDraft[i], rulesDraft[j]] = [rulesDraft[j], rulesDraft[i]];
      loadRules().then(dirty);
    };
  }
  for (const b of box.querySelectorAll("[data-del]")) {
    b.onclick = () => {
      read();
      rulesDraft.splice(Number(b.closest(".rule").dataset.i), 1);
      loadRules().then(dirty);
    };
  }
  document.getElementById("rules-add").onclick = () => {
    read();
    rulesDraft.unshift({
      id: `rule-${Date.now()}`,
      name: "New rule",
      match: { site: "domains", host: "any", domains: [] },
      actions: { captions: "off", panel: "hidden", audio: "click", summary: true, saveNotes: true, saveAudio: true },
    });
    loadRules().then(dirty);
  };
  document.getElementById("rules-reset").onclick = async () => {
    if (!confirm("Replace your rules with the defaults?")) return;
    await api("/settings", { method: "PATCH", body: JSON.stringify({ rules: "" }) });
    rulesDraft = null;
    notify("Rules reset to the defaults.", "success");
    loadRules();
  };
  document.getElementById("rules-save").onclick = async (e) => {
    read();
    e.target.loading = true;
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ rules: rulesDraft }) });
      rulesDraft = null;
      notify("Rules saved. They apply to calls and pages you open from now on.", "success");
      loadRules();
    } catch (err) {
      notify(err.message, "danger");
      e.target.loading = false;
    }
  };
}

const usd = (n) => (n == null ? "unknown" : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const TASKS = { summary: "Summary", question: "Question", test: "Key test" };

/** Settings › Usage: totals, by model, and every AI call with its cost. */
async function loadUsage() {
  const box = document.getElementById("usage");
  if (!box) return;
  const r = await api("/usage");
  const card = (label, t) => `<div class="panel" style="flex:1 1 180px">
    <div class="muted small">${label}</div>
    <div style="font-size:var(--sl-font-size-2x-large);font-weight:600">${usd(t.cost)}</div>
    <div class="muted small">${t.calls} call${t.calls === 1 ? "" : "s"} · ${tokens(t.input)} in · ${tokens(t.output)} out${t.unpriced ? ` · ${t.unpriced} unpriced` : ""}</div>
  </div>`;
  box.innerHTML = `
    <div class="row" style="align-items:stretch">${card("This month", r.thisMonth)}${card("Last 7 days", r.last7)}${card("All time", r.allTime)}</div>
    <p class="field-hint" style="margin:0">OpenRouter reports each call's cost, so those are exact. Anthropic reports tokens only, so its costs are
      estimated from list prices; your Anthropic Console billing page is the exact record.</p>
    ${
      r.byProvider.length
        ? `<div class="panel"><h2>This month by model</h2>${r.byProvider
            .map(
              (p) => `<div class="row" style="padding:4px 0"><span style="flex:1">${esc(p.provider === "openrouter" ? "OpenRouter" : "Anthropic")} · <code>${esc(p.model || "?")}</code></span>
              <span class="muted small">${p.calls} calls</span><b style="min-width:80px;text-align:right">${usd(p.cost)}</b></div>`,
            )
            .join("")}
            <div class="row muted small" style="margin-top:8px">${r.byTask.map((t) => `${TASKS[t.task] || t.task}: ${usd(t.cost)} (${t.calls})`).join(" · ")}</div></div>`
        : ""
    }
    <div class="panel">
      <h2>History</h2>
      ${
        r.recent.length
          ? `<div class="tablebox" style="border:0"><table class="meetings" style="min-width:760px"><thead><tr>
              <th>When</th><th>Capture</th><th>Task</th><th>Model</th><th>Tokens in / out</th><th style="text-align:right">Cost</th></tr></thead><tbody>
              ${r.recent
                .map(
                  (u) => `<tr>
                    <td style="white-space:nowrap">${when(u.at)}</td>
                    <td>${u.meeting_id ? `<a href="#/m/${esc(u.meeting_id)}">${esc(u.title || "deleted meeting")}</a>` : `<span class="muted">—</span>`}</td>
                    <td>${esc(TASKS[u.task] || u.task)}${u.ok ? "" : ` ${tag("failed", "danger")}`}</td>
                    <td><code class="small">${esc(u.model || "?")}</code></td>
                    <td>${tokens(u.input_tokens + u.cache_read + u.cache_write)} / ${tokens(u.output_tokens)}</td>
                    <td style="text-align:right">${usd(u.cost_usd)}${u.cost_usd != null && !u.cost_exact ? ` <span class="muted small">est.</span>` : ""}</td>
                  </tr>`,
                )
                .join("")}</tbody></table></div>`
          : `<p class="muted" style="margin:0">No AI calls yet. Each summary, question and key test will appear here with its cost.</p>`
      }
    </div>`;
}

let connectionsLoaded = false;
async function loadConnections() {
  if (connectionsLoaded && document.querySelector("[data-cal]")) return;
  connectionsLoaded = true;
  const box = document.getElementById("calendars");
  if (box) {
    box.innerHTML = loading("Loading your calendars…");
    try {
      const r = await api("/google/calendars");
      if (r.needsReconnect) {
        box.innerHTML = `<sl-alert variant="warning" open><sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
          To choose which calendars ClearNote reads, reconnect Google once. Until then it reads only your main calendar.</sl-alert>
          <sl-button variant="primary" href="/api/google/connect" style="margin-top:8px">Reconnect Google</sl-button>`;
      } else {
        const sel = new Set(r.selected);
        box.innerHTML = `<h3 style="margin-top:4px">Calendars to read</h3>
          <p class="field-hint" style="margin:0 0 6px">Calls are matched only against these. Untick personal calendars to keep them out.</p>
          <div class="stack" style="gap:6px">${r.calendars
            .map(
              (c) => `<sl-checkbox data-cal="${esc(c.primary ? "primary" : c.id)}" ${sel.has(c.id) || (c.primary && sel.has("primary")) ? "checked" : ""}>
                ${esc(c.name)}${c.primary ? ` <span class="muted">(main)</span>` : c.owner ? "" : ` <span class="muted">(shared with you)</span>`}</sl-checkbox>`,
            )
            .join("")}</div>`;
      }
    } catch (err) {
      box.innerHTML = `<p class="err">Could not list your calendars: ${esc(err.message)}</p>`;
    }
  }
  const up = document.getElementById("upcoming");
  if (up) {
    const events = await api("/calendar/upcoming");
    up.innerHTML = `<h2>Upcoming</h2>${
      events.length
        ? events
            .map(
              (e) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--sl-color-neutral-100)">
                <span style="flex:1">${esc(e.title)}</span><span class="muted small">${when(e.start_at)} · ${e.attendees.length} invited</span>
                ${e.meeting_id ? `<a href="#/m/${esc(e.meeting_id)}" class="small">captured</a>` : ""}</div>`,
            )
            .join("")
        : `<p class="muted" style="margin:0">Nothing synced yet.</p>`
    }`;
  }
}

/** Folder browser in a Shoelace dialog. Calls done(path) with the chosen folder. */
function chooseFolder(start, done) {
  const dlg = document.createElement("sl-dialog");
  dlg.label = "Choose a folder";
  dlg.style.setProperty("--width", "640px");
  document.body.append(dlg);
  let cur = null;

  const render = (d) => {
    cur = d;
    dlg.innerHTML = `
      <div class="row">${d.places.map((p) => `<sl-button size="small" data-go="${esc(p.path)}">${esc(p.name)}</sl-button>`).join("")}</div>
      <div class="row" style="margin:10px 0">
        <sl-button size="small" data-act="up" ${d.parent ? "" : "disabled"}><sl-icon slot="prefix" name="arrow-up"></sl-icon>Up</sl-button>
        <code class="pathbox">${esc(d.display)}</code>
      </div>
      <div class="dirs">${
        d.dirs.length
          ? d.dirs.map((n) => `<button type="button" class="dir" data-open="${esc(n)}">${esc(n)}/</button>`).join("")
          : `<p class="muted small" style="padding:8px;margin:0">No folders inside this one.</p>`
      }</div>
      <div class="row" style="margin-top:12px">
        <sl-input id="newFolder" size="small" placeholder="New folder name" style="flex:1"></sl-input>
        <sl-button size="small" data-act="mkdir">Create folder here</sl-button>
      </div>
      <p class="err small" id="folderErr"></p>
      <sl-button slot="footer" data-act="close">Cancel</sl-button>
      <sl-button slot="footer" variant="primary" data-act="use">Use this folder</sl-button>`;
  };
  const go = async (p) => {
    try {
      render(await api(`/folders?path=${encodeURIComponent(p)}`));
    } catch (err) {
      const e = dlg.querySelector("#folderErr");
      if (e) e.textContent = err.message;
    }
  };
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-go], [data-open], [data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.go) return go(b.dataset.go);
    if (b.dataset.open) return go(`${cur.path}/${b.dataset.open}`);
    if (b.dataset.act === "up" && cur.parent) return go(cur.parent);
    if (b.dataset.act === "close") return dlg.hide();
    if (b.dataset.act === "use") {
      done(cur.display);
      return dlg.hide();
    }
    if (b.dataset.act === "mkdir") {
      try {
        render(await api("/folders", { method: "POST", body: JSON.stringify({ parent: cur.path, name: dlg.querySelector("#newFolder").value }) }));
      } catch (err) {
        dlg.querySelector("#folderErr").textContent = err.message;
      }
    }
  });
  dlg.addEventListener("sl-after-hide", (e) => e.target === dlg && dlg.remove());
  go(start).then(() => {
    if (!cur) go("~");
    customElements.whenDefined("sl-dialog").then(() => dlg.show());
  });
}

// ------------------------------------------------------------------- people

let peopleSort = "meetings";

async function renderPeople() {
  view.innerHTML = loading("Loading people…");
  const list = await api(`/people?sort=${peopleSort}`);
  if (!list.length) {
    view.innerHTML = `<h1>People</h1><div class="empty"><b>No one yet.</b><br/>People appear here from the speakers in your calls
      and the invitees on matched calendar events.</div>`;
    return;
  }
  view.innerHTML = `
    <div class="row" style="align-items:flex-end;margin-bottom:16px">
      <div style="flex:1 1 300px">
        <h1>People</h1>
        <p class="sub" style="margin:0">${list.length} people you've met with, from call speakers and calendar invites.</p>
      </div>
      <sl-input id="pfind" size="small" placeholder="Find a person…" clearable style="width:220px"><sl-icon name="search" slot="prefix"></sl-icon></sl-input>
      <sl-radio-group id="psort" value="${peopleSort}" size="small">
        <sl-radio-button value="meetings">Most met</sl-radio-button>
        <sl-radio-button value="recent">Recent</sl-radio-button>
        <sl-radio-button value="name">A–Z</sl-radio-button>
      </sl-radio-group>
    </div>
    <div class="tablebox">
      <table class="meetings" style="min-width:720px">
        <thead><tr><th>Person</th><th>Meetings</th><th>Spoke in</th><th>Last met</th><th>First met</th><th></th></tr></thead>
        <tbody id="prows">
          ${list
            .map(
              (p) => `<tr data-find="${esc(`${p.name} ${p.email || ""}`.toLowerCase())}">
                <td><a class="mtitle" href="#/people/${p.id}">${esc(p.name)}</a><div class="muted small">${esc(p.email || "no email yet")}</div></td>
                <td>${p.meetings}</td>
                <td>${p.spoke}</td>
                <td style="white-space:nowrap">${when(p.last_met)}</td>
                <td style="white-space:nowrap" class="muted">${new Date(p.first_met).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</td>
                <td style="text-align:right"><sl-button size="small" href="#/?person=${p.id}">Their calls</sl-button></td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  document.getElementById("psort").addEventListener("sl-change", (e) => {
    peopleSort = e.target.value;
    renderPeople();
  });
  document.getElementById("pfind").addEventListener("sl-input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const tr of document.querySelectorAll("#prows tr")) tr.hidden = !!q && !tr.dataset.find.includes(q);
  });
}

async function renderPerson(id) {
  view.innerHTML = loading("Loading…");
  const [p, everyone] = await Promise.all([api(`/people/${id}`), api("/people?sort=name&hidden=1")]);
  const others = everyone.filter((o) => o.id !== p.id);
  const spoke = p.meetings.filter((m) => m.spoke).length;
  view.innerHTML = `
    <a href="#/people" class="small">← People</a>
    <div class="mhead">
      <div class="info">
        <label class="sr" for="pname">Name</label>
        <input class="edit-title" id="pname" value="${esc(p.name)}" />
        <p class="muted" style="margin:4px 0 8px">${p.email ? esc(p.email) : "No email yet"} · ${p.meetings.length} meeting${p.meetings.length === 1 ? "" : "s"} · spoke in ${spoke}
          ${p.meetings.length ? ` · last met ${when(p.meetings[0].started_at)}` : ""}</p>
        ${p.aliases.length > 1 ? `<p class="muted small" style="margin:0">Also appears as: ${esc(p.aliases.join(", "))}</p>` : ""}
        ${p.hidden ? tag("Hidden from People", "warning") : ""}
      </div>
      <div class="row">
        <sl-button href="#/?person=${p.id}"><sl-icon slot="prefix" name="funnel"></sl-icon>Show their calls in Captures</sl-button>
        <sl-dropdown placement="bottom-end" hoist id="pmore">
          <sl-icon-button slot="trigger" name="three-dots" label="More"></sl-icon-button>
          <sl-menu>
            <sl-menu-item value="email"><sl-icon slot="prefix" name="envelope"></sl-icon>${p.email ? "Change email" : "Add email"}</sl-menu-item>
            <sl-menu-item value="merge"><sl-icon slot="prefix" name="union"></sl-icon>Merge into another person…</sl-menu-item>
            <sl-menu-item value="hide"><sl-icon slot="prefix" name="${p.hidden ? "eye" : "eye-slash"}"></sl-icon>${p.hidden ? "Show in People" : "Hide from People"}</sl-menu-item>
          </sl-menu>
        </sl-dropdown>
      </div>
    </div>

    <div class="cols" style="margin-top:16px">
      <div class="main">
        <div class="tablebox">
          <table class="meetings" style="min-width:600px">
            <thead><tr><th>Meeting</th><th>When</th><th>Role</th></tr></thead>
            <tbody>
              ${p.meetings
                .map(
                  (m) => `<tr>
                    <td><a class="mtitle" href="#/m/${esc(m.id)}">${esc(m.title || "Untitled meeting")}</a>
                      <div class="headline">${esc(m.headline || m.platform_label || m.platform)}</div></td>
                    <td style="white-space:nowrap">${when(m.started_at)}</td>
                    <td>${m.spoke ? tag("Spoke", "primary") : m.response === "declined" ? tag("Declined") : tag("Invited")}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
      <aside class="side stack">
        <section class="panel">
          <h2>Open next steps</h2>
          ${
            p.actions.length
              ? p.actions
                  .map((a) => `<div style="padding:6px 0">${esc(a.text)}${a.due ? ` <span class="muted">(due ${esc(a.due)})</span>` : ""}
                    <div class="small"><a href="#/m/${esc(a.meeting_id)}">${esc(a.title || "meeting")}</a></div></div>`)
                  .join("")
              : `<p class="muted" style="margin:0">None assigned to ${esc(p.name.split(" ")[0])}.</p>`
          }
        </section>
      </aside>
    </div>

    <sl-dialog label="Merge ${esc(p.name)} into…" id="mergeDlg">
      <p class="muted" style="margin-top:0">Use this when the same person appears twice, for example under a nickname in captions and their full name on the invite.
        Their meetings and names move to the person you pick.</p>
      <sl-select id="mergeInto" label="Merge into" placeholder="Choose a person" hoist>
        ${others.map((o) => `<sl-option value="${o.id}">${esc(o.name)}${o.email ? ` (${esc(o.email)})` : ""}</sl-option>`).join("")}
      </sl-select>
      <sl-button slot="footer" id="mergeCancel">Cancel</sl-button>
      <sl-button slot="footer" variant="primary" id="mergeGo">Merge</sl-button>
    </sl-dialog>`;

  const patch = (body) => api(`/people/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
  const name = document.getElementById("pname");
  name.onchange = async () => {
    if (name.value.trim()) await patch({ name: name.value.trim() });
    notify("Name updated.", "success");
  };
  const dlg = document.getElementById("mergeDlg");
  document.getElementById("pmore").addEventListener("sl-select", async (e) => {
    const v = e.detail.item.value;
    if (v === "email") {
      const next = prompt(`Email for ${p.name}:`, p.email || "");
      if (next === null) return;
      try {
        await patch({ email: next.trim() || null });
        renderPerson(p.id);
      } catch (err) {
        notify(/UNIQUE/.test(err.message) ? "Another person already has that email. Merge them instead." : err.message, "danger");
      }
    } else if (v === "merge") dlg.show();
    else if (v === "hide") {
      await patch({ hidden: !p.hidden });
      notify(p.hidden ? "Shown in People again." : "Hidden from People. Their meetings are unchanged.");
      renderPerson(p.id);
    }
  });
  document.getElementById("mergeCancel").onclick = () => dlg.hide();
  document.getElementById("mergeGo").onclick = async () => {
    const into = document.getElementById("mergeInto").value;
    if (!into) return;
    await api(`/people/${p.id}/merge`, { method: "POST", body: JSON.stringify({ into: Number(into) }) });
    dlg.hide();
    notify("Merged.", "success");
    location.hash = `#/people/${into}`;
  };
}

// ------------------------------------------------------------- action items

async function renderActions() {
  view.innerHTML = loading("Loading action items…");
  const items = await api("/action-items");
  if (!items.length) {
    view.innerHTML = `<h1>Action items</h1><div class="empty"><b>Nothing open.</b><br/>Next steps from your captures show up here.</div>`;
    return;
  }
  view.innerHTML = `<h1>Action items</h1><p class="sub">${items.length} open across all captures</p>
    <div class="panel" id="actions">${items
      .map(
        (a) => `<div class="ai-item" data-id="${a.id}">
          <sl-checkbox></sl-checkbox>
          <div class="txt">${a.owner ? `<b>${esc(a.owner)}:</b> ` : ""}${esc(a.text)}
            <div class="muted small">${a.due ? `due ${esc(a.due)} · ` : ""}<a href="#/m/${esc(a.meeting_id)}">${esc(a.title || "meeting")}</a> · ${when(a.started_at)}</div></div>
        </div>`,
      )
      .join("")}</div>`;
  document.getElementById("actions").addEventListener("sl-change", async (e) => {
    const row = e.target.closest(".ai-item");
    if (!row) return;
    row.classList.toggle("done", e.target.checked);
    try {
      await api(`/action-items/${row.dataset.id}`, { method: "PATCH", body: JSON.stringify({ done: e.target.checked }) });
    } catch (err) {
      e.target.checked = !e.target.checked;
      row.classList.toggle("done", e.target.checked);
      notify(err.message, "danger");
    }
  });
}

// ------------------------------------------------------------------- router

function route() {
  clearTimeout(refreshTimer);
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0];
  const [part, ...rest] = hash.split("/");
  const section = ["actions", "settings", "people"].includes(part) ? part : "meetings";
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("on", a.dataset.nav === section);

  const show = (p) =>
    p.catch((err) => {
      view.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    });
  if (part === "m" && rest[0]) return show(renderMeeting(rest[0], rest[1] || "notes"));
  if (part === "actions") return show(renderActions());
  if (part === "people" && rest[0]) return show(renderPerson(rest[0]));
  if (part === "people") return show(renderPeople());
  if (part === "settings") return show(renderSettings(rest[0] || "general"));
  if (part === "tag" && rest[0]) return show(renderList({ tag: decodeURIComponent(rest[0]) }));
  if (part === "search" && rest[0]) return show(renderList({ q: decodeURIComponent(rest.join("/")) }));
  const person = new URLSearchParams(location.hash.split("?")[1] || "").get("person");
  return show(renderList({ person }));
}

let qTimer;
qInput.addEventListener("sl-input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const q = qInput.value.trim();
    location.hash = q ? `#/search/${encodeURIComponent(q)}` : "#/";
  }, 280);
});

// "Action items" in the top menu is optional (Settings › General).
function applyMenu(values) {
  const link = document.getElementById("nav-actions");
  if (link && values) link.hidden = values.showActionItems === false;
}
api("/settings").then((c) => applyMenu(c.values)).catch(() => {});

checkUpdates();
setInterval(checkUpdates, 30 * 60 * 1000);

window.addEventListener("hashchange", () => {
  connectionsLoaded = false;
  route();
});

api("/health")
  .then((h) => {
    const pill = document.getElementById("ai-state");
    pill.textContent = h.ai ? "AI on" : "AI off: add a key in Settings";
    pill.variant = h.ai ? "success" : "neutral";
  })
  .catch(() => {});

route();
