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
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

import { pickSource } from "./MusicStore";
import { SC_DISPATCH_TYPE, SCStore } from "./SCStore";
import { YTM_DISPATCH_TYPE, YTMusicStore } from "./YTMusicStore";

declare const VencordNative: {
    pluginHelpers: {
        MusicControls: {
            setRPCActivity(clientId: string, activity: object | null): Promise<void>;
        };
    };
};

const SOCKET_ID = "MusicControls";

const APPS = {
    soundcloud: { appId: "1500082049980043264", name: "SoundCloud", logo: "soundcloud-logo" },
    ytmusic: { appId: "1499934999896653935", name: "YouTube Music", logo: "ytm-logo" },
};

type PresenceSource = keyof typeof APPS;

// ── Image helpers ─────────────────────────────────────────────────────────────
// fetchAssetIds converts external URLs to Discord's mp:external/... format,
// which is required for LOCAL_ACTIVITY_UPDATE (renderer-local display).
// The real Discord IPC pipe (used by setRPCActivity) accepts raw HTTPS URLs
// directly — no conversion needed, just like soundcloud-rpc does.

const assetCache = new Map<string, string>();

async function getExternalAssetId(appId: string, url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    const cached = assetCache.get(url);
    if (cached) return cached;
    try {
        const ids = await Promise.race([
            ApplicationAssetUtils.fetchAssetIds(appId, [url]),
            new Promise<never>((_, reject) => setTimeout(reject, 3000)),
        ]);
        const id = (ids as string[])[0];
        if (id) {
            if (assetCache.size > 50) assetCache.clear();
            assetCache.set(url, id);
        }
        return id;
    } catch {
        return undefined;
    }
}

// ── Activity builder ──────────────────────────────────────────────────────────

function getActiveSource(): PresenceSource | null {
    if (!Settings.plugins.MusicControls.enablePresence) return null;
    const source = pickSource();
    // Spotify presence is handled natively by Discord
    return source === "spotify" ? null : source;
}

function buildActivity(source: PresenceSource) {
    const { appId, name, logo } = APPS[source];
    const store = source === "soundcloud" ? SCStore : YTMusicStore;
    const track = store.track;
    if (!track) return null;

    let imageUrl: string | undefined;
    let listenUrl: string | undefined;
    if (source === "soundcloud") {
        imageUrl = SCStore.track!.thumbnailOriginal;
        // Bare profile links (soundcloud.com/user) are not a track
        if (SCStore.track!.permalink?.split("/").length > 4) listenUrl = SCStore.track!.permalink;
    } else {
        // data: URLs can't be used as presence images
        if (track.thumbnail && !track.thumbnail.startsWith("data:")) imageUrl = track.thumbnail;
        if (YTMusicStore.track!.id) listenUrl = `https://music.youtube.com/watch?v=${YTMusicStore.track!.id}`;
    }

    const position = store.position;
    const now = Date.now();

    return {
        appId,
        imageUrl,
        activity: {
            name,
            type: 2,
            details: track.title,
            state: track.artist ? `by ${track.artist}` : undefined,
            timestamps: store.isPlaying && track.duration > 0 ? {
                start: Math.floor(now - position),
                end: Math.floor(now + (track.duration - position)),
            } : undefined,
            assets: {
                large_image: imageUrl || logo,
                large_text: track.title,
                small_image: logo,
                small_text: name,
            },
            buttons: listenUrl ? [{ label: `Listen on ${name}`, url: listenUrl }] : undefined,
        },
    };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function updatePresence() {
    try {
        const source = getActiveSource();
        const built = source && buildActivity(source);

        // Real Discord IPC RPC — makes presence visible to other users.
        // Raw CDN image URLs work over the pipe; mp:external/... only works locally.
        if (built) VencordNative.pluginHelpers.MusicControls.setRPCActivity(built.appId, { ...built.activity, instance: false });
        else VencordNative.pluginHelpers.MusicControls.setRPCActivity("", null);

        // LOCAL_ACTIVITY_UPDATE — updates your own client display
        let localActivity: object | null = null;
        if (built) {
            const largeImage = await getExternalAssetId(built.appId, built.imageUrl);
            localActivity = {
                ...built.activity,
                application_id: built.appId,
                assets: largeImage ? { ...built.activity.assets, large_image: largeImage } : undefined,
            };
        }
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: localActivity,
            socketId: SOCKET_ID,
        });
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
// SC/YTM dispatch every poll tick (150 ms while playing), so a plain debounce
// would never fire. Instead, only schedule an update when what the presence
// shows actually changes: source, track, play state, or a seek.

const WATCHED_EVENTS = [SC_DISPATCH_TYPE, YTM_DISPATCH_TYPE, "SPOTIFY_PLAYER_STATE"];
const SEEK_THRESHOLD_MS = 2000;

let lastKey: string | null = null;
let lastStart = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onDispatch() {
    const source = getActiveSource();
    const store = source === "soundcloud" ? SCStore : source === "ytmusic" ? YTMusicStore : null;
    const track = store?.track;
    const key = store && track ? `${source}|${track.id}|${track.title}|${track.artist}|${store.isPlaying}` : "";
    const start = store?.isPlaying ? Date.now() - store.position : 0;

    if (key === lastKey && Math.abs(start - lastStart) < SEEK_THRESHOLD_MS) return;
    lastKey = key;
    lastStart = start;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updatePresence, 500);
}

export function startPresence() {
    lastKey = null;
    for (const type of WATCHED_EVENTS) FluxDispatcher.subscribe(type, onDispatch);
    updatePresence();
}

export function stopPresence() {
    for (const type of WATCHED_EVENTS) FluxDispatcher.unsubscribe(type, onDispatch);
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    clearPresence();
}
