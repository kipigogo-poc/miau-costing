// Install-as-app support for the ordering page.
(() => {
  const btn = document.getElementById("getapp");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/order" }).catch(() => {}));

  // Offline notice (menu and orders need a connection)
  const note = () => {
    let el = document.getElementById("offline");
    if (navigator.onLine) { el && el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "offline"; el.className = "offline"; el.textContent = "You're offline — reconnect to see the live menu and place orders.";
      document.body.prepend(el); }
  };
  addEventListener("online", note); addEventListener("offline", note); note();

  if (standalone || !btn) return;
  // Android / Chrome / Edge: native install prompt
  let deferred = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; btn.hidden = false; });
  addEventListener("appinstalled", () => { btn.hidden = true; deferred = null; });
  // iPhone / iPad Safari: no prompt exists, so show how to add it
  const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) btn.hidden = false;
  btn.addEventListener("click", async () => {
    if (deferred) { deferred.prompt(); const r = await deferred.userChoice; if (r.outcome === "accepted") btn.hidden = true; deferred = null; return; }
    if (ios) showTip();
  });
  function showTip() {
    if (document.getElementById("ios-tip")) return;
    const d = document.createElement("div"); d.id = "ios-tip"; d.className = "ios-tip"; d.setAttribute("role", "dialog");
    d.innerHTML = `<img src="brand/app-192.png" alt=""><div>Tap <b>Share</b> <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="share icon"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg> then <b>Add to Home Screen</b> to get the MIAU app.</div><button class="x" aria-label="Close">×</button>`;
    d.querySelector(".x").onclick = () => d.remove(); document.body.append(d);
  }
})();
