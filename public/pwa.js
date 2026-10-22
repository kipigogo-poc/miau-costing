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
  // Always offer the button (outside the installed app). Chrome/Edge/Android give a one-tap install prompt;
  // everywhere else we show the right steps for that browser.
  btn.hidden = false;
  let deferred = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; });
  addEventListener("appinstalled", () => { btn.hidden = true; deferred = null; tip(); });
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|TikTok|Twitter/i.test(ua);
  const android = /Android/.test(ua);
  const share = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="share icon"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>`;
  function steps() {
    if (inApp) return ios ? `Open this page in <b>Safari</b> first: tap <b>⋯</b> then <b>Open in Safari</b>. Then tap <b>Share</b> ${share} → <b>Add to Home Screen</b>.`
                          : `Open this page in <b>Chrome</b> first: tap <b>⋮</b> then <b>Open in Chrome</b>. Then tap <b>App</b> again.`;
    if (ios) return /CriOS|FxiOS|EdgiOS/.test(ua) ? `Tap <b>Share</b> ${share} then <b>Add to Home Screen</b>. (If you don't see it, open this page in Safari.)`
                                                  : `Tap <b>Share</b> ${share} then <b>Add to Home Screen</b> to get the MIAU app.`;
    if (android) return /SamsungBrowser/.test(ua) ? `Tap the menu <b>☰</b> then <b>Add page to</b> → <b>Home screen</b>.`
                                                  : `Tap the menu <b>⋮</b> then <b>Install app</b> or <b>Add to Home screen</b>.`;
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return `In Safari, choose <b>File</b> → <b>Add to Dock</b>.`;
    if (/Firefox/.test(ua)) return `Firefox on computers can't install apps. Open this page in <b>Chrome</b> or <b>Edge</b>, or on your phone.`;
    return `Click the install icon <b>⊕</b> at the right end of the address bar, or open the browser menu → <b>Install MIAU</b>. If it's already installed, open it from your apps.`;
  }
  btn.addEventListener("click", async () => {
    if (deferred) { deferred.prompt(); const r = await deferred.userChoice; deferred = null; if (r.outcome === "accepted") btn.hidden = true; return; }
    tip(steps());
  });
  function tip(html) {
    document.getElementById("ios-tip")?.remove(); if (!html) return;
    const d = document.createElement("div"); d.id = "ios-tip"; d.className = "ios-tip"; d.setAttribute("role", "dialog");
    d.innerHTML = `<img src="brand/app-192.png" alt=""><div>${html}</div><button class="x" aria-label="Close">×</button>`;
    d.querySelector(".x").onclick = () => d.remove(); document.body.append(d);
  }
})();
