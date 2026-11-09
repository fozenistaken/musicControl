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

const REQUEST_TIMEOUT_MS = 2000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 15000;

const state = {
    ytm: { connected: false, lastTrack: null, inFlight: false, queued: null, retryAt: 0, retryDelay: 0 },
    sc:  { connected: false, lastTrack: null, inFlight: false, queued: null, retryAt: 0, retryDelay: 0 },
};

// ── Tab injection ─────────────────────────────────────────────────────────────
// The manifest injects into every tab that loads after the extension starts.
// Tabs that were already open when it was installed, updated or reloaded
// still run the old (now disconnected) relay, so give them a fresh one.

const INJECT = {
    ytm: { url: "https://music.youtube.com/*", main: "ytm_content_main.js", relay: "ytm_content.js" },
    sc:  { url: "https://soundcloud.com/*",    main: "sc_content_main.js",  relay: "sc_content.js" },
};

chrome.runtime.onInstalled.addListener(() => {
    for (const { url, main, relay } of Object.values(INJECT)) {
        chrome.tabs.query({ url }, tabs => tabs.forEach(async ({ id }) => {
            try {
                await chrome.scripting.executeScript({ target: { tabId: id }, files: [main],  world: "MAIN" });
                await chrome.scripting.executeScript({ target: { tabId: id }, files: [relay], world: "ISOLATED" });
            } catch { }
        }));
    }
});

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
            const res = await fetch(smallUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!res.ok) return url;
            const bytes = new Uint8Array(await res.arrayBuffer());
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
// One request per service at a time: updates that arrive meanwhile replace each
// other, and only the newest is sent once the current request finishes.
// While Discord isn't answering, updates are dropped and a retry is attempted
// every 2 s, backing off to 15 s, instead of failing ten times a second.

function queueSync(service, data, tabId) {
    const slot = state[service];
    if (Date.now() < slot.retryAt) return;
    slot.queued = { data, tabId };
    if (!slot.inFlight) flushSync(service);
}

async function flushSync(service) {
    const slot = state[service];
    slot.inFlight = true;
    while (slot.queued) {
        const { data, tabId } = slot.queued;
        slot.queued = null;
        await syncState(service, data, tabId);
    }
    slot.inFlight = false;
}

async function syncState(service, data, activeTabId) {
    const slot = state[service];
    try {
        let payload = data;
        if (service === "sc" && data?.track?.thumbnail) {
            const originalUrl = data.track.thumbnail;
            const dataUrl = await toDataUrl(originalUrl);
            payload = { ...data, track: { ...data.track, thumbnail: dataUrl, thumbnailOriginal: originalUrl } };
        }

        const res = await fetch(`${SERVERS[service]}/state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        slot.connected  = true;
        slot.retryDelay = 0;
        slot.lastTrack  = data?.track ?? null;

        const { control } = await res.json();
        if (!control?.action) return;

        // Send control only to the one tab that is currently active
        chrome.tabs.sendMessage(activeTabId, { type: "CONTROL", ...control }).catch(() => {});
    } catch {
        slot.connected  = false;
        slot.queued     = null;
        slot.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, slot.retryDelay * 2));
        slot.retryAt    = Date.now() + slot.retryDelay;
    }
}

// ── Message router ────────────────────────────────────────────────────────────

const UPDATE_TYPES = { YTM_STATE_UPDATE: "ytm", SC_STATE_UPDATE: "sc" };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const service = UPDATE_TYPES[msg.type];
    if (service) {
        const tabId = sender.tab?.id;
        if (tabId == null) return;
        recordTab(service, tabId, msg.data?.isPlaying ?? false);
        // Only the active tab drives the server state
        if (tabId === getActiveTabId(service)) queueSync(service, msg.data, tabId);
    } else if (msg.type === "GET_STATUS") {
        sendResponse({
            ytm: { connected: state.ytm.connected, lastTrack: state.ytm.lastTrack },
            sc:  { connected: state.sc.connected,  lastTrack: state.sc.lastTrack },
        });
    }
});
