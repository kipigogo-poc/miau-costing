// Install-as-app for the staff app. window.miauInstall() is called from the Account sheet.
(() => {
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw-staff.js", { scope: "/" }).catch(() => {}));
  let deferred = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; });
  addEventListener("appinstalled", () => { deferred = null; });
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\//i.test(ua);
  window.miauStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.miauInstall = async () => {
    if (deferred) { deferred.prompt(); const r = await deferred.userChoice; deferred = null; return r.outcome === "accepted" ? "installed" : "dismissed"; }
    if (inApp) return ios ? "Open this page in <b>Safari</b> first, then tap <b>Share</b> → <b>Add to Home Screen</b>." : "Open this page in <b>Chrome</b> first, then tap <b>Install app</b> again.";
    if (ios) return "Tap <b>Share</b> (the square with an arrow) then <b>Add to Home Screen</b>.";
    if (/Android/.test(ua)) return /SamsungBrowser/.test(ua) ? "Tap the menu <b>☰</b> → <b>Add page to</b> → <b>Home screen</b>." : "Tap the menu <b>⋮</b> → <b>Install app</b> or <b>Add to Home screen</b>.";
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return "In Safari choose <b>File</b> → <b>Add to Dock</b>.";
    if (/Firefox/.test(ua)) return "Firefox on computers can't install apps. Use <b>Chrome</b> or <b>Edge</b>.";
    return "Click the install icon <b>⊕</b> at the right end of the address bar, or browser menu → <b>Install MIAU Staff</b>. If it's already installed, open it from your apps.";
  };
})();
