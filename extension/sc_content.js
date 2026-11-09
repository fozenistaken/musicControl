// sc_content.js — Isolated world relay for SoundCloud.
// Bridges sc_content_main.js <-> background.js
// The newest relay always takes over: after the extension reloads, the old relay
// is disconnected, so background.js injects a fresh one and the old one retires.
(function () {

const token = Math.random().toString(36).slice(2);
document.documentElement.dataset.scBridgeRelay = token;

function retire() {
    window.removeEventListener("message", onPageMessage);
    try { chrome.runtime.onMessage.removeListener(onControl); } catch { }
}

function onPageMessage(event) {
    // Only accept messages from the page itself, not from embedded frames
    if (event.source !== window || !event.data?.__scBridge) return;
    if (document.documentElement.dataset.scBridgeRelay !== token) return retire();
    try {
        chrome.runtime.sendMessage({ type: "SC_STATE_UPDATE", data: event.data.state }).catch(() => {});
    } catch {
        retire(); // extension reloaded or removed
    }
}

function onControl(msg) {
    if (msg.type !== "CONTROL") return;
    window.postMessage({ __scBridgeControl: true, ...msg }, location.origin);
}

window.addEventListener("message", onPageMessage);
chrome.runtime.onMessage.addListener(onControl);

})();
