// Only what the extension needs to reach the server lives here. Everything
// else is in the dashboard's Settings page.
const DEFAULTS = { serverUrl: "http://localhost:8787", token: "" };

const base = (u) => (u || DEFAULTS.serverUrl).replace(/\/$/, "");

chrome.storage.sync.get(DEFAULTS).then((s) => {
  document.getElementById("serverUrl").value = s.serverUrl;
  document.getElementById("token").value = s.token;
  document.getElementById("openDashboard").href = `${base(s.serverUrl)}/#/settings`;
});

document.getElementById("save").onclick = async () => {
  const serverUrl = document.getElementById("serverUrl").value.trim() || DEFAULTS.serverUrl;
  const token = document.getElementById("token").value.trim();
  // The dashboard lives on the same origin as the API.
  await chrome.storage.sync.set({ serverUrl, token, dashboardUrl: serverUrl });
  document.getElementById("openDashboard").href = `${base(serverUrl)}/#/settings`;
  const saved = document.getElementById("saved");
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 1600);
};

// The recorder runs in an offscreen page, which cannot show Chrome's mic
// prompt. Granting access here, on an extension page, covers it too.
async function paintMic() {
  const out = document.getElementById("micState");
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    out.textContent = p.state === "granted" ? "Allowed" : p.state === "denied" ? "Blocked in Chrome's site settings" : "";
  } catch {
    out.textContent = "";
  }
}
document.getElementById("allowMic").onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (err) {
    document.getElementById("micState").textContent = `Not allowed: ${err.message}`;
    return;
  }
  paintMic();
};
paintMic();
