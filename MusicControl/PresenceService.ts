/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Settings } from "@api/Settings";
import { FluxDispatcher, ApplicationAssetUtils } from "@webpack/common";

import { SCStore } from "./SCStore";
import { SpotifyStore } from "./SpotifyStore";
import { YTMusicStore } from "./YTMusicStore";

declare const VencordNative: {
    pluginHelpers: {
        MusicControls: {
            setRPCActivity(clientId: string, activity: object | null): Promise<void>;
        };
    };
};

const SOCKET_ID = "MusicControls";

// ── Image helpers ─────────────────────────────────────────────────────────────
// fetchAssetIds converts external URLs to Discord's mp:external/... format,
// which is required for LOCAL_ACTIVITY_UPDATE (renderer-local display).
// The real Discord IPC pipe (used by setRPCActivity) accepts raw HTTPS URLs
// directly — no conversion needed, just like soundcloud-rpc does.

async function getExternalAssetId(appId: string, url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    try {
        const ids = await Promise.race([
            ApplicationAssetUtils.fetchAssetIds(appId, [url]),
            new Promise<never>((_, reject) => setTimeout(reject, 3000)),
        ]);
        return (ids as string[])[0];
    } catch {
        return undefined;
    }
}

// ── LOCAL_ACTIVITY_UPDATE builders (for your own client) ──────────────────────

async function buildSCActivity() {
    const track = SCStore.track;
    if (!track) return null;

    const position = SCStore.position;
    const duration = track.duration;
    const now = Date.now();
    const appId = "1500082049980043264";

    const large_image = await getExternalAssetId(appId, track.thumbnailOriginal);

    return {
        name: "SoundCloud",
        type: 2,
        application_id: appId,
        details: track.title,
        state: track.artist ? `by ${track.artist}` : undefined,
        timestamps: SCStore.isPlaying && duration > 0 ? {
            start: Math.floor(now - position),
            end:   Math.floor(now + (duration - position)),
        } : undefined,
        assets: large_image ? {
            large_image,
            large_text: track.title,
            small_image: "soundcloud-logo",
            small_text:  "SoundCloud",
        } : undefined,
        buttons: track.permalink && track.permalink.split("/").length > 4 ? [
            { label: "Listen on SoundCloud", url: track.permalink },
        ] : undefined,
    };
}

async function buildYTMActivity() {
    const track = YTMusicStore.track;
    if (!track) return null;

    const position = YTMusicStore.position;
    const duration = track.duration;
    const now = Date.now();
    const appId = "1499934999896653935";

    const url = (track.thumbnail && !track.thumbnail.startsWith("data:")) ? track.thumbnail : undefined;
    const large_image = await getExternalAssetId(appId, url);

    return {
        name: "YouTube Music",
        type: 2,
        application_id: appId,
        details: track.title,
        state: track.artist ? `by ${track.artist}` : undefined,
        timestamps: YTMusicStore.isPlaying && duration > 0 ? {
            start: Math.floor(now - position),
            end:   Math.floor(now + (duration - position)),
        } : undefined,
        assets: large_image ? {
            large_image,
            large_text: track.title,
            small_image: "ytm-logo",
            small_text:  "YouTube Music",
        } : undefined,
        buttons: track.id ? [
            { label: "Listen on YouTube Music", url: `https://music.youtube.com/watch?v=${track.id}` },
        ] : undefined,
    };
}

// ── Real IPC RPC builders (visible to other users) ────────────────────────────
// These are synchronous — no fetchAssetIds needed.
// Raw CDN URLs work directly over the Discord IPC pipe, the same way
// soundcloud-rpc passes artworkUrl straight into largeImageKey.

function buildSCRPCActivity(): { appId: string; activity: object } | null {
    const track = SCStore.track;
    if (!track) return null;

    const position = SCStore.position;
    const duration = track.duration;
    const now = Date.now();
    const appId = "1500082049980043264";

    return {
        appId,
        activity: {
            name:    "SoundCloud",
            type:    2,
            details: track.title,
            state:   track.artist ? `by ${track.artist}` : undefined,
            timestamps: SCStore.isPlaying && duration > 0 ? {
                start: Math.floor(now - position),
                end:   Math.floor(now + (duration - position)),
            } : undefined,
            assets: {
                large_image: track.thumbnailOriginal || "soundcloud-logo",
                large_text:  track.title,
                small_image: "soundcloud-logo",
                small_text:  "SoundCloud",
            },
            buttons: track.permalink && track.permalink.split("/").length > 4 ? [
                { label: "Listen on SoundCloud", url: track.permalink },
            ] : undefined,
            instance: false,
        },
    };
}

function buildYTMRPCActivity(): { appId: string; activity: object } | null {
    const track = YTMusicStore.track;
    if (!track) return null;

    const position = YTMusicStore.position;
    const duration = track.duration;
    const now = Date.now();
    const appId = "1499934999896653935";

    const thumbnailUrl = (track.thumbnail && !track.thumbnail.startsWith("data:"))
        ? track.thumbnail : undefined;

    return {
        appId,
        activity: {
            name:    "YouTube Music",
            type:    2,
            details: track.title,
            state:   track.artist ? `by ${track.artist}` : undefined,
            timestamps: YTMusicStore.isPlaying && duration > 0 ? {
                start: Math.floor(now - position),
                end:   Math.floor(now + (duration - position)),
            } : undefined,
            assets: {
                large_image: thumbnailUrl || "ytm-logo",
                large_text:  track.title,
                small_image: "ytm-logo",
                small_text:  "YouTube Music",
            },
            buttons: track.id ? [
                { label: "Listen on YouTube Music", url: `https://music.youtube.com/watch?v=${track.id}` },
            ] : undefined,
            instance: false,
        },
    };
}

// ── Priority resolution ───────────────────────────────────────────────────────

function _getActiveSource() {
    const settings = Settings.plugins.MusicControls;
    if (!settings.enablePresence) return null;
    if (SpotifyStore.track && SpotifyStore.device?.is_active && SpotifyStore.isPlaying) return null;

    const scPlaying  = !!(SCStore.track  && SCStore.isPlaying);
    const ytmPlaying = !!(YTMusicStore.track && YTMusicStore.isPlaying);
    const priority   = (settings.presencePriority as string | undefined) ?? "sc_ytm";

    if (scPlaying || ytmPlaying) {
        if (priority === "sc_ytm") return scPlaying ? "sc" : "ytm";
        return ytmPlaying ? "ytm" : "sc";
    }
    // Paused fallback
    if (priority === "sc_ytm") return SCStore.track ? "sc" : YTMusicStore.track ? "ytm" : null;
    return YTMusicStore.track ? "ytm" : SCStore.track ? "sc" : null;
}

export async function getPresenceActivity() {
    const source = _getActiveSource();
    if (!source) return null;
    if (source === "sc")  return buildSCActivity();
    return buildYTMActivity();
}

function getRPCActivity() {
    const source = _getActiveSource();
    if (!source) return null;
    if (source === "sc")  return buildSCRPCActivity();
    return buildYTMRPCActivity();
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function updatePresence() {
    try {
        // LOCAL_ACTIVITY_UPDATE — updates your own client display
        const localActivity = await getPresenceActivity();
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: localActivity,
            socketId: SOCKET_ID,
        });

        // Real Discord IPC RPC — makes presence visible to other users.
        // Uses raw CDN image URLs (same as soundcloud-rpc / @xhayper/discord-rpc).
        // mp:external/... URLs only work in LOCAL_ACTIVITY_UPDATE, not over the pipe.
        const rpc = getRPCActivity();
        if (rpc) {
            VencordNative.pluginHelpers.MusicControls.setRPCActivity(rpc.appId, rpc.activity);
        } else {
            VencordNative.pluginHelpers.MusicControls.setRPCActivity("", null);
        }
    } catch (e) {
        console.error("[MusicControls] updatePresence failed:", e);
    }
}

export function clearPresence() {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: null,
        socketId: SOCKET_ID,
    });
    VencordNative.pluginHelpers.MusicControls.setRPCActivity("", null);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const WATCHED_EVENTS = [
    "MC_SOUNDCLOUD_STATE_UPDATE",
    "MC_YTMUSIC_STATE_UPDATE",
    "SPOTIFY_PLAYER_STATE",
    "MC_SOURCE_OVERRIDE",
];

let _interval: ReturnType<typeof setInterval> | null = null;
let _debounce: ReturnType<typeof setTimeout> | null = null;

const _onDispatch = () => {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(updatePresence, 1000);
};

export function startPresence() {
    for (const type of WATCHED_EVENTS) FluxDispatcher.subscribe(type, _onDispatch);
    updatePresence();
    _interval = setInterval(updatePresence, 10_000);
}

export function stopPresence() {
    for (const type of WATCHED_EVENTS) FluxDispatcher.unsubscribe(type, _onDispatch);
    if (_debounce !== null) { clearTimeout(_debounce); _debounce = null; }
    if (_interval !== null) { clearInterval(_interval); _interval = null; }
    clearPresence();
}
