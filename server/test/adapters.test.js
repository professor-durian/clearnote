// Which pages each adapter claims, and what it calls the meeting.
//
// Added after a live call was missed: Meet had moved to serving calls at
// /meet/<code> and the matcher only accepted <code> at the root. URL shapes
// change without notice, so they get pinned down here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "..", "..", "extension");

/** Load the adapters with a stubbed page, so `location` can be moved around. */
function loadAdapters() {
  const sandbox = {
    window: {},
    crypto: { randomUUID: () => Math.random().toString(36) },
    location: { hostname: "", pathname: "/", search: "", href: "" },
    document: { title: "", querySelector: () => null, querySelectorAll: () => [] },
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  for (const f of [
    "lib/util.js",
    "lib/segmenter.js",
    "platforms/meet.js",
    "platforms/zoom.js",
    "platforms/teams.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ext, f), "utf8"), sandbox, { filename: f });
  }
  const goTo = (url) => {
    const u = new URL(url);
    Object.assign(sandbox.location, {
      hostname: u.hostname,
      pathname: u.pathname,
      search: u.search,
      href: url,
    });
  };
  return { adapters: sandbox.window.ClearNote.adapters, goTo, sandbox };
}

const { adapters, goTo, sandbox } = loadAdapters();
const byId = (id) => adapters.find((a) => a.id === id);
const matching = () => adapters.filter((a) => a.matches());

// ------------------------------------------------------------------ Meet

test("Meet is recognised at the classic root URL", () => {
  goTo("https://meet.google.com/abc-defg-hij");
  assert.equal(byId("google_meet").matches(), true);
  assert.equal(byId("google_meet").meetingKey(), "meet:abc-defg-hij");
});

// The exact shape that was missed in a real call.
test("Meet is recognised under the /meet/ path prefix", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  assert.equal(byId("google_meet").matches(), true, "this URL shape must not be skipped");
  assert.equal(
    byId("google_meet").meetingKey(),
    "meet:aka-gsvq-fjh",
    "the key is the room code, whichever path shape Meet uses",
  );
});

test("the same call keys identically under either Meet URL shape", () => {
  goTo("https://meet.google.com/abc-defg-hij");
  const rootKey = byId("google_meet").meetingKey();
  goTo("https://meet.google.com/meet/abc-defg-hij");
  assert.equal(byId("google_meet").meetingKey(), rootKey, "or a reload would split the meeting in two");
});

test("Meet query strings and trailing segments do not break the code", () => {
  goTo("https://meet.google.com/meet/abc-defg-hij?authuser=1&hs=187");
  assert.equal(byId("google_meet").meetingKey(), "meet:abc-defg-hij");
  goTo("https://meet.google.com/abc-defg-hij/");
  assert.equal(byId("google_meet").meetingKey(), "meet:abc-defg-hij");
});

test("a named Meet room is recognised", () => {
  goTo("https://meet.google.com/lookup/team-standup");
  assert.equal(byId("google_meet").matches(), true);
  assert.equal(byId("google_meet").meetingKey(), "meet:lookup-team-standup");
});

test("Meet's own pages are not treated as calls", () => {
  for (const url of [
    "https://meet.google.com/",
    "https://meet.google.com/landing",
    "https://meet.google.com/_meet/about",
  ]) {
    goTo(url);
    assert.equal(byId("google_meet").matches(), false, `${url} is not a call`);
  }
});

test("the fallback title uses the room code, not the raw path", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  sandbox.document.title = "Google Meet";
  assert.equal(byId("google_meet").meetingTitle(), "Meet aka-gsvq-fjh");
});

test("a real meeting name beats the fallback", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  sandbox.document.title = "Meet – Pricing sync";
  assert.equal(byId("google_meet").meetingTitle(), "Pricing sync");
  sandbox.document.title = "";
});

// ------------------------------------------------------------- Zoom, Teams

test("the Zoom web client is recognised, and keyed by meeting number", () => {
  goTo("https://us02web.zoom.us/wc/98765432109/join?pwd=x");
  assert.equal(byId("zoom").matches(), true);
  assert.equal(byId("zoom").meetingKey(), "zoom:98765432109");
});

test("Zoom company subdomains and the newer /wc/join/ address give the same meeting", () => {
  for (const url of [
    "https://greenlightcloud.zoom.us/j/82428478525?pwd=x",
    "https://greenlightcloud.zoom.us/wc/82428478525/join?pwd=x",
    "https://app.zoom.us/wc/join/82428478525",
  ]) {
    goTo(url);
    assert.equal(byId("zoom").matches(), true, url);
    assert.equal(byId("zoom").meetingKey(), "zoom:82428478525", url);
  }
});

test("Teams is recognised on both its hosts", () => {
  for (const url of [
    "https://teams.microsoft.com/v2/?meetingId=19%3ameeting_abc",
    "https://teams.live.com/v2/?meetingId=19%3ameeting_abc",
  ]) {
    goTo(url);
    assert.equal(byId("teams").matches(), true, url);
  }
});

// ------------------------------------------------------------------ overlap

test("exactly one adapter claims any given meeting page", () => {
  for (const url of [
    "https://meet.google.com/meet/aka-gsvq-fjh",
    "https://us02web.zoom.us/wc/98765432109/join",
    "https://teams.microsoft.com/v2/?meetingId=19%3ameeting_abc",
  ]) {
    goTo(url);
    assert.equal(matching().length, 1, `${url} should be claimed once, not ${matching().length} times`);
  }
});

// ---------------------------------------------------------------------------
// Meet renders controls inside the caption region. In a real call its
// "Jump to bottom" button was transcribed, with the Material Icon's ligature
// text ("arrow_downward") taken as the speaker's name.
// ---------------------------------------------------------------------------

/** Minimal stand-in for the bits of a DOM element the adapter touches. */
function el({ tag = "div", cls = "", text = "", attrs = {}, children = [] }) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: cls,
    dataset: {},
    children,
    _attrs: attrs,
    get textContent() {
      return children.length ? children.map((c) => c.textContent).join(" ") : text;
    },
    getAttribute: (n) => attrs[n] ?? null,
    matches(sel) {
      return sel.split(",").some((raw) => {
        const s = raw.trim();
        if (s === "button") return node.tagName === "BUTTON";
        if (s === "i") return node.tagName === "I";
        if (s === '[role="button"]') return attrs.role === "button";
        if (s === '[aria-hidden="true"]') return attrs["aria-hidden"] === "true";
        const m = s.match(/^\[class\*="(.+)"\]$/);
        if (m) return cls.includes(m[1]);
        return false;
      });
    },
    closest(sel) {
      return node.matches(sel) ? node : node._parent?.closest?.(sel) ?? null;
    },
    querySelector: () => null,
    querySelectorAll: (sel) =>
      descendants(node).filter((d) => {
        try {
          return d.matches(sel);
        } catch {
          return false;
        }
      }),
  };
  for (const c of children) c._parent = node;
  return node;
}
const descendants = (n) => n.children.flatMap((c) => [c, ...descendants(c)]);

test("Meet's own controls are not transcribed as speech", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  const meet = byId("google_meet");

  const jumpButton = el({
    tag: "button",
    attrs: { role: "button" },
    children: [
      el({ tag: "i", cls: "google-material-icons", text: "arrow_downward" }),
      el({ text: "Jump to bottom" }),
    ],
  });
  const root = { children: [jumpButton], querySelector: () => null, querySelectorAll: () => [] };

  // Length, not deepEqual: the array comes from the sandbox realm.
  const rows = meet.readCaptions(root);
  assert.equal(rows.length, 0, "a button is not a caption row");
  assert.ok(
    !rows.some((r) => r.speaker === "arrow_downward"),
    "an icon ligature is never a speaker name",
  );
});

// ---------------------------------------------------------------------------
// Enabling captions. The control flips its own label and Meet sets no
// aria-pressed on it, so a loose match on "captions" also hits "Turn off
// captions" — which would switch off the very thing being read.
// ---------------------------------------------------------------------------

/** Install a fake toolbar that `buttonByLabel` can search. */
function toolbar(...labels) {
  const nodes = labels.map((label) =>
    el({ tag: "button", attrs: { "aria-label": label, role: "button" } }),
  );
  sandbox.document.querySelectorAll = (sel) =>
    /button/.test(sel) || /menuitem/.test(sel) ? nodes : [];
  sandbox.document.querySelector = () => null;
  return nodes;
}

test("captions already on are detected from the control's label", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  toolbar("Turn off captions (c)");
  assert.equal(byId("google_meet").captionState(), "on");
});

test("captions off are detected from the control's label", () => {
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  toolbar("Turn on captions (c)");
  assert.equal(byId("google_meet").captionState(), "off");
});

test("a 'Turn off captions' control is never mistaken for a way to turn them on", () => {
  // The regression: this is what would have switched captions off mid-call.
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  const [offBtn] = toolbar("Turn off captions (c)");
  let clicked = false;
  offBtn.click = () => {
    clicked = true;
  };
  assert.equal(byId("google_meet").captionState(), "on");
  assert.equal(clicked, false, "state is read without touching the control");
});

test("buttonByLabel reaches controls inside a menu", () => {
  // On narrow windows Meet moves captions into the More options menu.
  goTo("https://meet.google.com/meet/aka-gsvq-fjh");
  const item = el({ tag: "div", attrs: { role: "menuitem", "aria-label": "Turn on captions" } });
  sandbox.document.querySelectorAll = (sel) => (/menuitem/.test(sel) ? [item] : []);
  const CN = sandbox.window.ClearNote;
  assert.equal(CN.buttonByLabel(/turn on captions/i), item);
});
