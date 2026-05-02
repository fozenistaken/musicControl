// sc_content_main.js — Runs in SoundCloud's MAIN world.
// Selectors verified against live SoundCloud DOM.
if (!window.__scBridgeMainLoaded) { window.__scBridgeMainLoaded = true; (function () {

const POLL_MS = 150;

// ── Exact selectors from live DOM inspection ──────────────────────────────────
const SEL = {
    // Transport buttons — matched by stable class names (no aria-label on prev/next)
    prev:    ".playControls__prev",          // skipControl__previous
    play:    ".playControls__play",          // has aria-label="Pause current" or "Play current"
    next:    ".playControls__next",          // skipControl__next
    shuffle: ".shuffleControl",              // title="Shuffle"
    repeat:  ".repeatControl",              // title="Repeat"

    // Player badge artwork — sc-artwork-4x is the one in the player bar
    artworkBadge: "span.sc-artwork.sc-artwork-4x.image__full",

    // Timeline (SoundCloud uses a custom div, not <input type=range>)
    timeline: ".playbackTimeline__progressWrapper",
    timelineBar: ".playbackTimeline__scrubber, .playbackTimeline__progressWrapper",
};

function q(sel) { return document.querySelector(sel); }

// ── Thumbnail ─────────────────────────────────────────────────────────────────

function upgradeScUrl(url) {
    // Replace any size suffix with t500x500 for best quality
    return url.replace(/-(t\d+x\d+|large|small|tiny|mini|badge|crop)\.(jpg|jpeg|png|webp)/i, "-t500x500.$2");
}

function getThumbnail() {
    // Player bar artwork badge first — always the playing track regardless of page viewed
    const el = q(SEL.artworkBadge);
    if (el) {
        const bg = el.style?.backgroundImage || getComputedStyle(el).backgroundImage || "";
        const m  = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m?.[1] && !m[1].includes("about:blank")) return upgradeScUrl(m[1]);
    }

    // Fallback: MediaSession artwork (may reflect viewed page, not playing track)
    const artwork = navigator.mediaSession?.metadata?.artwork;
    if (artwork?.length) {
        let best = artwork[0];
        let bestSize = 0;
        for (const a of artwork) {
            const m = (a.sizes || "").match(/t?(\d+)x/);
            const size = m ? parseInt(m[1]) : 0;
            if (size > bestSize) { bestSize = size; best = a; }
        }
        if (best?.src) return best.src;
    }

    return "";
}

// ── State helpers ─────────────────────────────────────────────────────────────

function cleanTitle(t) {
    // Strip "Current track: " prefix that SC injects for screen readers
    return t ? t.replace(/^Current\s+track:\s*/i, "").trim() : "";
}

function getTitle() {
    const el = q(".playbackSoundBadge__titleLink");
    if (el) {
        // innerText respects CSS visibility and skips SC's sc-visuallyhidden
        // accessibility span ("Current track: ...") that textContent includes
        const text = (el.innerText ?? el.textContent ?? "").trim();
        const clean = cleanTitle(text);
        if (clean) return clean;
    }
    return cleanTitle(navigator.mediaSession?.metadata?.title ?? "");
}

function getArtist() {
    return navigator.mediaSession?.metadata?.artist
        || q(".playbackSoundBadge__lightLink")?.textContent?.trim()
        || "";
}

function getTrackPermalink() {
    // .playbackSoundBadge__titleLink confirmed working — returns full track URL
    const a = q(".playbackSoundBadge__titleLink");
    if (a?.href && a.href.split("/").length > 4) return a.href.split("?")[0];
    return "";
}

function getTrackId() {
    const link = getTrackPermalink();
    return link ? link.replace("https://soundcloud.com", "") : getTitle();
}

function getIsPlaying() {
    // Play button has class 'playing' when a track is playing
    const btn = q(SEL.play);
    if (btn) return btn.classList.contains("playing");
    // MediaSession fallback
    const ms = navigator.mediaSession?.playbackState;
    if (ms === "playing") return true;
    if (ms === "paused")  return false;
    return false;
}

function getPosition() {
    // aria-valuenow confirmed in SECONDS (aria-valuetext = "N seconds"), no audio element exists
    const prog = q(SEL.timeline);
    if (!prog) return 0;
    return Math.round(parseFloat(prog.getAttribute("aria-valuenow") || "0") * 1000);
}

function getDuration() {
    // aria-valuemax confirmed in SECONDS, no audio element exists
    const prog = q(SEL.timeline);
    if (!prog) return 0;
    const max = parseFloat(prog.getAttribute("aria-valuemax") || "0");
    return max > 0 ? Math.round(max * 1000) : 0;
}

function getVolume() {
    // SoundCloud's custom volume slider exposes aria-valuenow (0–1) on .volume__sliderWrapper
    const wrapper = q(".volume__sliderWrapper");
    if (wrapper) {
        const now = parseFloat(wrapper.getAttribute("aria-valuenow") ?? "1");
        const max = parseFloat(wrapper.getAttribute("aria-valuemax") ?? "1");
        if (max > 0) return Math.round((now / max) * 100);
    }
    return 100;
}

function getShuffle() {
    // SoundCloud adds 'm-shuffling' class to the shuffle button when active
    return q(SEL.shuffle)?.classList.contains("m-shuffling") ?? false;
}

function getRepeat() {
    // SoundCloud uses m-all / m-one / m-none classes on the repeat button
    const btn = q(SEL.repeat);
    if (!btn) return "NONE";
    if (btn.classList.contains("m-all")) return "ALL";
    if (btn.classList.contains("m-one")) return "ONE";
    return "NONE"; // m-none or absent
}

// ── State builder ─────────────────────────────────────────────────────────────

function buildState() {
    const title = getTitle();
    if (!title) return null;

    return {
        track: {
            id:        getTrackId(),
            title,
            artist:    getArtist(),
            duration:  getDuration(),
            thumbnail: getThumbnail(),
            permalink: getTrackPermalink(),
        },
        isPlaying: getIsPlaying(),
        position:  getPosition(),
        volume:    getVolume(),
        shuffle:   getShuffle(),
        repeat:    getRepeat(),
    };
}

// ── Sending ───────────────────────────────────────────────────────────────────

let lastJson = "";
let _forceSend = false;

function sendState() {
    try {
        const state = buildState();
        const json  = state ? JSON.stringify(state) : "null";
        const changed = json !== lastJson;
        if (changed) lastJson = json;
        // Always send when: state changed, OR paused (so pending controls are picked up),
        // OR a forced startup send is requested.
        if (changed || !state?.isPlaying || _forceSend) {
            _forceSend = false;
            window.postMessage({ __scBridge: true, state: state ?? null }, "*");
        }
    } catch { }
}


setInterval(sendState, POLL_MS);

function setupObserver() {
    const bar = q(".playControls");
    if (!bar) { setTimeout(setupObserver, 1000); return; }
    new MutationObserver(sendState).observe(bar, { attributes: true, childList: true, subtree: true });
}
setupObserver();

// Force-send after short delays so MediaSession artwork (loaded async) is captured
setTimeout(() => { _forceSend = true; sendState(); }, 500);
setTimeout(() => { _forceSend = true; sendState(); }, 2000);


// Instant track-change detection via MediaSession hook
try {
    const desc = Object.getOwnPropertyDescriptor(window.MediaSession.prototype, "metadata");
    if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(window.MediaSession.prototype, "metadata", {
            get: desc.get,
            set(v) { orig.call(this, v); setTimeout(sendState, 60); },
            configurable: true,
        });
    }
} catch { }

// ── Controls ──────────────────────────────────────────────────────────────────

window.addEventListener("message", (event) => {
    if (!event.data?.__scBridgeControl) return;

    switch (event.data.action) {

        case "PLAY":
            if (!getIsPlaying()) q(SEL.play)?.click();
            break;

        case "PAUSE":
            if (getIsPlaying()) q(SEL.play)?.click();
            break;

        case "NEXT":
            q(SEL.next)?.click();
            break;

        case "PREVIOUS":
            q(SEL.prev)?.click();
            break;

        case "SEEK": {
            // SoundCloud uses a custom timeline div — simulate a click at the right X position
            const bar = q(SEL.timelineBar) || q(SEL.timeline);
            if (bar) {
                const dur = getDuration();
                if (dur > 0) {
                    const pct  = Math.max(0, Math.min(1, event.data.value / dur));
                    const rect = bar.getBoundingClientRect();
                    // mousedown + mouseup at the target position
                    const x = rect.left + rect.width * pct;
                    const y = rect.top + rect.height / 2;
                    ["mousedown", "mouseup", "click"].forEach(type =>
                        bar.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
                    );
                }
            }
            break;
        }

        case "VOLUME": {
            const pct   = Math.max(0, Math.min(100, event.data.value)) / 100;
            const volEl = q(".volume");
            const sliderBg = q(".volume__sliderBackground");
            if (!volEl || !sliderBg) break;

            // Force the CSS expanded state so the slider has a real layout rect.
            // Without this the slider height is 0 and every click lands at the top (= 100%).
            const wasExpanded = volEl.classList.contains("expanded");
            volEl.classList.add("expanded");
            void volEl.offsetHeight; // force synchronous reflow

            const rect = sliderBg.getBoundingClientRect();
            if (rect.height > 0) {
                // Vertical slider: bottom edge = 0%, top edge = 100%
                const x = rect.left + rect.width / 2;
                const y = rect.bottom - rect.height * pct;
                ["mousedown", "mousemove", "mouseup"].forEach(type =>
                    sliderBg.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
                );
            }

            // Remove forced class after SC has processed the interaction
            if (!wasExpanded) {
                setTimeout(() => volEl.classList.remove("expanded"), 400);
            }
            break;
        }


        case "SHUFFLE": {
            const want = !!event.data.value;
            if (getShuffle() !== want) q(SEL.shuffle)?.click();
            break;
        }

        case "REPEAT": {
            // SC's actual click cycle: ALL → NONE → ONE → ALL
            // value encoding: 0=NONE, 1=ALL, 2=ONE (from SCStore.setRepeat)
            const valueMap = ["NONE", "ALL", "ONE"];
            const scCycle  = ["ALL", "NONE", "ONE"]; // SC's real button cycle order
            const current  = getRepeat();
            const target   = valueMap[event.data.value ?? 0] ?? "NONE";
            if (current === target) break;
            // How many clicks to go from current → target following SC's cycle?
            const steps = ((scCycle.indexOf(target) - scCycle.indexOf(current)) + 3) % 3;
            for (let i = 0; i < steps; i++) {
                setTimeout(() => q(SEL.repeat)?.click(), i * 80);
            }
            break;
        }
    }
});

})(); }
