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

/**
 * MusicStore — Unified source selection.
 *
 * Priority: Spotify > SoundCloud / YouTube Music (order set by presencePriority)
 *
 * pickSource() is the single source of truth: the UI, the controls and the
 * presence all go through it, so buttons always act on the track being shown.
 */

import { Settings } from "@api/Settings";
import { useStateFromStores } from "@webpack/common";

import { SCStore } from "./SCStore";
import { SpotifyStore } from "./SpotifyStore";
import { YTMusicStore } from "./YTMusicStore";

export type MusicSource = "spotify" | "soundcloud" | "ytmusic" | null;
type ActiveSource = Exclude<MusicSource, null>;
type Repeat = "off" | "context" | "track";

export const MUSIC_STORES = [SpotifyStore, SCStore, YTMusicStore];

// Most recently playing source. Used as the paused fallback so the UI
// doesn't jump to another source when everything pauses.
let lastPlayingSource: MusicSource = null;

export interface MusicData {
    source: ActiveSource;
    title: string;
    artist: string;
    thumbnail: string;      // image URL
    openUrl: string;        // where to open externally
    isPlaying: boolean;
    shuffle: boolean;
    repeat: Repeat;
    accentColor: string;
    /** Repeat state the repeat button switches to */
    nextRepeat: Repeat;
    repeatClassName: "repeat-off" | "repeat-context" | "repeat-track";
}

const LABELS: Record<ActiveSource, string> = {
    spotify: "Spotify",
    soundcloud: "SoundCloud",
    ytmusic: "YouTube Music",
};

export const sourceLabel = (source: ActiveSource) => LABELS[source];

function getStore(source: ActiveSource) {
    return source === "spotify" ? SpotifyStore : source === "soundcloud" ? SCStore : YTMusicStore;
}

export function getVolume(source: ActiveSource): number {
    return getStore(source).volume ?? 100;
}

// ── Source selection ──────────────────────────────────────────────────────────

function hasTrack(source: ActiveSource) {
    if (source === "spotify") return !!(SpotifyStore.track && SpotifyStore.device?.is_active);
    return !!getStore(source).track;
}

function isPlaying(source: ActiveSource) {
    return hasTrack(source) && getStore(source).isPlaying;
}

export function pickSource(): ActiveSource | null {
    const order: ActiveSource[] = Settings.plugins.MusicControls.presencePriority === "ytm_sc"
        ? ["spotify", "ytmusic", "soundcloud"]
        : ["spotify", "soundcloud", "ytmusic"];

    const playing = order.find(isPlaying);
    if (playing) return lastPlayingSource = playing;

    if (lastPlayingSource && hasTrack(lastPlayingSource)) return lastPlayingSource;
    return order.find(hasTrack) ?? null;
}

// ── Data builders ─────────────────────────────────────────────────────────────

function ytmRepeatToUnified(r: string): Repeat {
    if (r === "ALL") return "context";
    if (r === "ONE") return "track";
    return "off";
}

const NEXT_REPEAT: Record<Repeat, Repeat> = { off: "context", context: "track", track: "off" };

function buildData(source: ActiveSource): MusicData {
    const store = getStore(source);
    const repeat = source === "spotify" ? SpotifyStore.repeat : ytmRepeatToUnified(store.repeat);
    const common = {
        source,
        isPlaying: store.isPlaying,
        shuffle: store.shuffle,
        repeat,
        nextRepeat: NEXT_REPEAT[repeat],
        repeatClassName: `repeat-${repeat}` as const,
    };

    if (source === "spotify") {
        const track = SpotifyStore.track!;
        return {
            ...common,
            title: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            thumbnail: track.album.image.url,
            openUrl: `https://open.spotify.com/track/${track.id}`,
            accentColor: "#1db954",
        };
    }

    if (source === "soundcloud") {
        const track = SCStore.track!;
        return {
            ...common,
            title: track.title,
            artist: track.artist,
            thumbnail: track.thumbnail,
            openUrl: track.permalink || "https://soundcloud.com",
            accentColor: "#ff5500",
        };
    }

    const track = YTMusicStore.track!;
    return {
        ...common,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail,
        openUrl: `https://music.youtube.com/watch?v=${track.id}`,
        accentColor: "#ff0033",
    };
}

function sameData(prev: MusicData | null, next: MusicData | null) {
    if (prev === next) return true;
    if (!prev || !next) return false;
    return (
        prev.source === next.source &&
        prev.title === next.title &&
        prev.artist === next.artist &&
        prev.thumbnail === next.thumbnail &&
        prev.openUrl === next.openUrl &&
        prev.isPlaying === next.isPlaying &&
        prev.shuffle === next.shuffle &&
        prev.repeat === next.repeat
    );
}

export function useMusicData(): MusicData | null {
    return useStateFromStores(
        MUSIC_STORES,
        () => {
            const source = pickSource();
            return source && buildData(source);
        },
        null,
        sameData
    );
}

// ── Controls ──────────────────────────────────────────────────────────────────
// Resolve the target at call time so they always act on the displayed source.

function unifiedRepeatToYTM(r: Repeat): "NONE" | "ALL" | "ONE" {
    if (r === "context") return "ALL";
    if (r === "track") return "ONE";
    return "NONE";
}

function target() {
    const source = pickSource();
    return source && getStore(source);
}

export const MusicControls = {
    setPlaying(v: boolean) { target()?.setPlaying(v); },
    next() { target()?.next(); },
    prev() {
        const t = target();
        if (!t) return;
        if (Settings.plugins.MusicControls.previousButtonRestartsTrack && t.position > 3000)
            t.seek(0);
        else
            t.prev();
    },
    setVolume(v: number) { target()?.setVolume(v); },
    setShuffle(v: boolean) { target()?.setShuffle(v); },
    setRepeat(r: Repeat) {
        const t = target();
        if (t === SpotifyStore) t.setRepeat(r);
        else (t as typeof SCStore | null)?.setRepeat(unifiedRepeatToYTM(r));
    },
    openExternal() {
        const t = target();
        if (t === SpotifyStore) t.openExternal(`/track/${SpotifyStore.track!.id}`);
        else if (t === SCStore) SCStore.openInSoundCloud();
        else if (t === YTMusicStore) YTMusicStore.openInYTMusic();
    },
};
