// ytm_content.js — Isolated world relay for YouTube Music.
// Bridges ytm_content_main.js <-> background.js
// Guard uses DOM attribute to prevent double-injection.
if (!document.documentElement.dataset.ytmBridgeLoaded) { document.documentElement.dataset.ytmBridgeLoaded = "1"; (function () {

window.addEventListener("message", (event) => {
    if (!event.data?.__ytmBridge) return;
    try {
        chrome.runtime.sendMessage({ type: "YTM_STATE_UPDATE", data: event.data.state }).catch(() => {});
    } catch {
        // Extension reloaded — clear guard so background.js can re-inject
        delete document.documentElement.dataset.ytmBridgeLoaded;
    }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CONTROL") return;
    window.postMessage({ __ytmBridgeControl: true, ...msg }, "*");
});

})(); }
