// ytm_content_main.js — Runs in YouTube Music's MAIN world.
// Has full access to the YTM JS player API.
// Guard prevents double-injection.
if (!window.__ytmBridgeMainLoaded) { window.__ytmBridgeMainLoaded = true; (function () {

const POLL_MS = 100;

function player() { return document.querySelector("#movie_player"); }

const SEL = {
    repeat:   "ytmusic-player-bar yt-icon-button.repeat:not([id])",
    shuffle:  "ytmusic-player-bar yt-icon-button.shuffle:not([id])",
    next:     "ytmusic-player-bar yt-icon-button.next-button",
    previous: "ytmusic-player-bar yt-icon-button.previous-button",
};

function tap(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    (el.querySelector("button") ?? el).click();
    return true;
}

// Toggle state cache — getComputedStyle forces layout so we refresh at 500ms
let _shuffle = false;
let _repeat  = "NONE";

function refreshToggles() {
    const shuffleBtn = document.querySelector("ytmusic-player-bar yt-icon-button.shuffle:not([id]) button");
    _shuffle = !!shuffleBtn && getComputedStyle(shuffleBtn).color === "rgb(255, 255, 255)";
    const repeatBtn = document.querySelector("ytmusic-player-bar yt-icon-button.repeat:not([id]) button");
    if (!repeatBtn || getComputedStyle(repeatBtn).color !== "rgb(255, 255, 255)") {
        _repeat = "NONE";
    } else {
        const path = document.querySelector("ytmusic-player-bar yt-icon-button.repeat:not([id]) path");
        _repeat = path?.getAttribute("d")?.includes("M13 15V8") ? "ONE" : "ALL";
    }
}

function getShuffle() { return _shuffle; }
function getRepeat()  { return _repeat; }

function getThumbnail(videoId) {
    const el =
        document.querySelector("ytmusic-player-bar .thumbnail-image") ??
        document.querySelector("#song-image .thumbnail-image");
    let src = el?.src;
    if (src && src !== "undefined" && !src.endsWith("undefined")) {
        if (src.includes("lh3.googleusercontent.com"))
            src = src.replace(/=w\d+.*$/, "=w500-h500-l90-rj");
        else if (src.includes("i.ytimg.com"))
            src = src.replace(/\/\w+default\.jpg$/, "/maxresdefault.jpg");
        return src;
    }
    return videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "";
}

function buildState() {
    const p = player();
    if (!p || typeof p.getPlayerState !== "function") return null;
    const playerState = p.getPlayerState();
    if (playerState === -1) return null;

    const videoData = p.getVideoData?.() ?? {};
    const videoId   = videoData.video_id ?? "";
    const titleEl   = document.querySelector(".title.ytmusic-player-bar");
    const artistEl  = document.querySelector(".subtitle.ytmusic-player-bar a");
    const title     = titleEl?.textContent?.trim() || videoData.title || "";
    const artist    = videoData.author || artistEl?.textContent?.trim() || "";
    if (!videoId && !title) return null;

    return {
        track: {
            id: videoId, title, artist,
            duration:  Math.round((p.getDuration?.() ?? 0) * 1000),
            thumbnail: getThumbnail(videoId),
        },
        isPlaying: playerState === 1,
        position:  Math.round((p.getCurrentTime?.() ?? 0) * 1000),
        volume:    p.isMuted?.() ? 0 : (p.getVolume?.() ?? 100),
        shuffle:   getShuffle(),
        repeat:    getRepeat(),
    };
}

let lastJson = "";

function sendState() {
    try {
        const state = buildState();
        if (!state) return;
        const json = JSON.stringify(state);
        if (json !== lastJson) { lastJson = json; window.postMessage({ __ytmBridge: true, state }, "*"); }
    } catch { }
}

function setupObserver() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) { setTimeout(setupObserver, 500); return; }
    refreshToggles();
    new MutationObserver(sendState)
        .observe(bar, { attributes: true, subtree: true, attributeFilter: ["aria-label", "aria-pressed"] });
}
setupObserver();
setInterval(refreshToggles, 500);

setInterval(() => {
    const state = buildState();
    if (!state) return;
    const json = JSON.stringify(state);
    const changed = json !== lastJson;
    if (changed) lastJson = json;
    if (changed || !state.isPlaying) window.postMessage({ __ytmBridge: true, state }, "*");
}, POLL_MS);

// ── Controls ──────────────────────────────────────────────────────────────────

window.addEventListener("message", (event) => {
    if (!event.data?.__ytmBridgeControl) return;
    const p = player();

    switch (event.data.action) {
        case "PLAY":     p?.playVideo?.();  break;
        case "PAUSE":    p?.pauseVideo?.(); break;
        case "NEXT":
            // p.nextVideo() confirmed available — faster than DOM click
            if (p?.nextVideo) p.nextVideo();
            else tap(SEL.next);
            break;
        case "PREVIOUS":
            if (p && (p.getCurrentTime?.() ?? 0) > 3) p.seekTo(0, true);
            else if (p?.previousVideo) p.previousVideo();
            else tap(SEL.previous);
            break;
        case "SEEK":     p?.seekTo?.(event.data.value / 1000, true); break;
        case "VOLUME":   p?.setVolume?.(event.data.value);           break;
        case "SHUFFLE": {
            const want = event.data.value;
            if (want == null || getShuffle() !== !!want) {
                tap(SEL.shuffle);
                setTimeout(refreshToggles, 150);
            }
            break;
        }
        case "REPEAT": {
            const order = ["NONE", "ALL", "ONE"];
            const want  = event.data.value;
            let taps = 1;
            if (want != null) {
                const target = order[want] ?? "NONE";
                taps = ((order.indexOf(target) - order.indexOf(getRepeat())) + 3) % 3;
            }
            for (let i = 0; i < taps; i++) tap(SEL.repeat);
            if (taps > 0) setTimeout(refreshToggles, 150);
            break;
        }
    }
});

})(); }
