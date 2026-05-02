/**
 * background.js — Service worker for the Music Controls Vencord Bridge.
 *
 * Routes state to the correct local server:
 *   YouTube Music → http://127.0.0.1:8547/state
 *   SoundCloud    → http://127.0.0.1:8548/state
 *
 * Receives control commands back from each server and forwards them
 * to the active tab only.
 */

const SERVERS = {
    ytm: "http://127.0.0.1:8547",
    sc:  "http://127.0.0.1:8548",
};

const state = {
    ytm: { connected: false, lastTrack: null },
    sc:  { connected: false, lastTrack: null },
};

// ── Tab injection ─────────────────────────────────────────────────────────────

async function injectYTM(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["ytm_content_main.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["ytm_content.js"],      world: "ISOLATED" });
    } catch { }
}

async function injectSC(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["sc_content_main.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["sc_content.js"],      world: "ISOLATED" });
    } catch { }
}

chrome.tabs.query({ url: "https://music.youtube.com/*" }, tabs => tabs.forEach(t => injectYTM(t.id)));
chrome.tabs.query({ url: "https://soundcloud.com/*"    }, tabs => tabs.forEach(t => injectSC(t.id)));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (tab.url?.startsWith("https://music.youtube.com/")) injectYTM(tabId);
    if (tab.url?.startsWith("https://soundcloud.com/"))    injectSC(tabId);
});

setInterval(() => {
    chrome.tabs.query({ url: "https://music.youtube.com/*" }, tabs => tabs.forEach(t => injectYTM(t.id)));
    chrome.tabs.query({ url: "https://soundcloud.com/*"    }, tabs => tabs.forEach(t => injectSC(t.id)));
}, 8000);

// ── Active-tab tracking ───────────────────────────────────────────────────────
// When multiple tabs are open for the same service, only the one that is
// actively playing should supply state and receive controls.
//
// Scoring:
//   - A tab that is currently playing scores 1e12 + the timestamp when it
//     started playing, so the most-recently-started playing tab always wins.
//   - A paused/idle tab scores only its lastSeen timestamp, so it acts as a
//     fallback when nothing is playing (controls still reachable).
//   - Tabs not heard from in the last 5 s are considered stale and ignored.

const tabStates = {
    ytm: new Map(), // tabId → { isPlaying, lastSeen, playingSince }
    sc:  new Map(),
};

function recordTab(service, tabId, isPlaying) {
    const prev = tabStates[service].get(tabId);
    tabStates[service].set(tabId, {
        isPlaying,
        lastSeen:     Date.now(),
        // Only update playingSince when transitioning from paused → playing
        playingSince: (isPlaying && !prev?.isPlaying) ? Date.now() : (prev?.playingSince ?? 0),
    });
}

function getActiveTabId(service) {
    const now = Date.now();
    let bestId    = null;
    let bestScore = -1;

    for (const [tabId, info] of tabStates[service]) {
        if (now - info.lastSeen > 5000) continue; // stale tab
        const score = info.isPlaying
            ? 1e12 + info.playingSince  // playing: prefer most recently started
            : info.lastSeen;            // paused:  prefer most recently heard from
        if (score > bestScore) { bestScore = score; bestId = tabId; }
    }
    return bestId;
}

// Clean up when a tab closes
chrome.tabs.onRemoved.addListener(tabId => {
    tabStates.ytm.delete(tabId);
    tabStates.sc.delete(tabId);
});

// ── Thumbnail proxy ───────────────────────────────────────────────────────────

const _thumbCache   = new Map();
const _thumbPending = new Map();

async function toDataUrl(url) {
    if (!url || url.startsWith("data:")) return url;
    if (_thumbCache.has(url))   return _thumbCache.get(url);
    if (_thumbPending.has(url)) return _thumbPending.get(url);

    const p = (async () => {
        try {
            const smallUrl = url.replace(
                /-(t\d+x\d+|large|small|tiny|mini|badge|crop|original)\.(jpg|jpeg|png|webp)/i,
                "-t200x200.$2"
            );
            const res   = await fetch(smallUrl);
            const buf   = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary  = "";
            for (let i = 0; i < bytes.length; i += 8192)
                binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            const mime    = res.headers.get("content-type") || "image/jpeg";
            const dataUrl = `data:${mime};base64,${btoa(binary)}`;
            _thumbCache.set(url, dataUrl);
            if (_thumbCache.size > 20) _thumbCache.delete(_thumbCache.keys().next().value);
            return dataUrl;
        } catch {
            return url;
        }
    })();

    _thumbPending.set(url, p);
    try { return await p; } finally { _thumbPending.delete(url); }
}

// ── State sync ────────────────────────────────────────────────────────────────
// activeTabId replaces the old tabUrl query — controls go only to that tab.

async function syncState(server, slot, data, activeTabId, convertThumb) {
    try {
        let payload = data;
        if (convertThumb && data?.track?.thumbnail) {
            const originalUrl = data.track.thumbnail;
            const dataUrl = await toDataUrl(originalUrl);
            payload = { ...data, track: { ...data.track, thumbnail: dataUrl, thumbnailOriginal: originalUrl } };
        }

        const res = await fetch(`${server}/state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        slot.connected = res.ok;
        if (!res.ok) return;
        slot.lastTrack = data?.track ?? null;

        const { control } = await res.json();
        if (!control?.action || !activeTabId) return;

        // Send control only to the one tab that is currently active
        chrome.tabs.sendMessage(activeTabId, { type: "CONTROL", ...control }).catch(() => {});
    } catch {
        slot.connected = false;
    }
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (msg.type === "YTM_STATE_UPDATE") {
        if (!tabId) return;
        recordTab("ytm", tabId, msg.data?.isPlaying ?? false);
        // Only the active tab drives the server state
        if (tabId === getActiveTabId("ytm")) {
            syncState(SERVERS.ytm, state.ytm, msg.data, tabId, false);
        }

    } else if (msg.type === "SC_STATE_UPDATE") {
        if (!tabId) return;
        recordTab("sc", tabId, msg.data?.isPlaying ?? false);
        if (tabId === getActiveTabId("sc")) {
            syncState(SERVERS.sc, state.sc, msg.data, tabId, true);
        }

    } else if (msg.type === "GET_STATUS") {
        sendResponse({ ytm: state.ytm, sc: state.sc });
        return true;
    }
});
