// sc_content.js — Isolated world relay for SoundCloud.
// Bridges sc_content_main.js <-> background.js
// Guard uses DOM attribute to prevent double-injection.
if (!document.documentElement.dataset.scBridgeLoaded) { document.documentElement.dataset.scBridgeLoaded = "1"; (function () {

window.addEventListener("message", (event) => {
    if (!event.data?.__scBridge) return;
    try {
        chrome.runtime.sendMessage({ type: "SC_STATE_UPDATE", data: event.data.state }).catch(() => {});
    } catch {
        // Extension reloaded — clear guard so background.js can re-inject
        delete document.documentElement.dataset.scBridgeLoaded;
    }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CONTROL") return;
    window.postMessage({ __scBridgeControl: true, ...msg }, "*");
});

})(); }
