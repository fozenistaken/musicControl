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
 * MusicStore — Unified source selection hook.
 *
 * Priority: Spotify > SoundCloud > YouTube Music
 *
 * Returns reactive UI data (no functions) via useStateFromStores.
 * Control functions are looked up by source at call time — stable references.
 */

import { Settings } from "@api/Settings";
import { FluxDispatcher, useStateFromStores } from "@webpack/common";

import { SCStore } from "./SCStore";
import { SpotifyStore } from "./SpotifyStore";
import { YTMusicStore } from "./YTMusicStore";

export type MusicSource = "spotify" | "soundcloud" | "ytmusic" | null;

// Manual source override — dispatched so both MusicStore and PresenceService react
export const MC_SOURCE_OVERRIDE = "MC_SOURCE_OVERRIDE";
let _manualOverride: MusicSource = null;

export function setSourceOverride(source: MusicSource) {
    _manualOverride = source;
    FluxDispatcher.dispatch({ type: MC_SOURCE_OVERRIDE, source });
}
export function getSourceOverride(): MusicSource { return _manualOverride; }

// Tracks the most recently actively-playing source.
// Used as a stable fallback when all sources are paused so the UI
// doesn't jump to an arbitrary source based on load order.
let _lastPlayingSource: MusicSource = null;

export interface MusicData {
    source: MusicSource;
    title: string;
    artist: string;
    thumbnail: string;      // image URL
    openUrl: string;        // where to open externally
    duration: number;       // ms
    isPlaying: boolean;
    volume: number;         // 0–100
    shuffle: boolean;
    /** Normalized repeat: "off" | "context" | "track" */
    repeat: "off" | "context" | "track";
    accentColor: string;
    /** Normalized next repeat state (for cycling the repeat button) */
    nextRepeat: "off" | "context" | "track";
    repeatClassName: "repeat-off" | "repeat-context" | "repeat-track";
}

// ── Repeat normalization helpers ──────────────────────────────────────────────

function ytmRepeatToUnified(r: string): "off" | "context" | "track" {
    if (r === "ALL") return "context";
    if (r === "ONE") return "track";
    return "off";
}

function cycleRepeat(r: "off" | "context" | "track"): ["off" | "context" | "track", "repeat-off" | "repeat-context" | "repeat-track"] {
    switch (r) {
        case "off":     return ["context", "repeat-off"];
        case "context": return ["track",   "repeat-context"];
        case "track":   return ["off",     "repeat-track"];
    }
}

// ── Unified hook ──────────────────────────────────────────────────────────────

export function useMusicData(): MusicData | null {
    return useStateFromStores(
        [SpotifyStore, SCStore, YTMusicStore],
        (): MusicData | null => {

            // Define the builders for each source
            const buildSpotify = (): MusicData | null => {
                if (SpotifyStore.track && SpotifyStore.device?.is_active) {
                    const repeat = SpotifyStore.repeat as "off" | "context" | "track";
                    const [nextRepeat, repeatClassName] = cycleRepeat(repeat);
                    return {
                        source: "spotify",
                        title: SpotifyStore.track.name,
                        artist: SpotifyStore.track.artists.map(a => a.name).join(", "),
                        thumbnail: SpotifyStore.track.album.image.url,
                        openUrl: `https://open.spotify.com/track/${SpotifyStore.track.id}`,
                        duration: SpotifyStore.track.duration,
                        isPlaying: SpotifyStore.isPlaying,
                        volume: SpotifyStore.volume,
                        shuffle: SpotifyStore.shuffle,
                        repeat,
                        nextRepeat,
                        repeatClassName,
                        accentColor: "#1db954",
                    };
                }
                return null;
            };

            const buildSC = (): MusicData | null => {
                if (SCStore.track) {
                    const repeat = ytmRepeatToUnified(SCStore.repeat);
                    const [nextRepeat, repeatClassName] = cycleRepeat(repeat);
                    return {
                        source: "soundcloud",
                        title: SCStore.track.title,
                        artist: SCStore.track.artist,
                        thumbnail: SCStore.track.thumbnail,
                        openUrl: SCStore.track.permalink || "https://soundcloud.com",
                        duration: SCStore.track.duration,
                        isPlaying: SCStore.isPlaying,
                        volume: SCStore.volume,
                        shuffle: SCStore.shuffle,
                        repeat,
                        nextRepeat,
                        repeatClassName,
                        accentColor: "#ff5500",
                    };
                }
                return null;
            };

            const buildYTM = (): MusicData | null => {
                if (YTMusicStore.track) {
                    const repeat = ytmRepeatToUnified(YTMusicStore.repeat);
                    const [nextRepeat, repeatClassName] = cycleRepeat(repeat);
                    return {
                        source: "ytmusic",
                        title: YTMusicStore.track.title,
                        artist: YTMusicStore.track.artist,
                        thumbnail: YTMusicStore.track.thumbnail,
                        openUrl: `https://music.youtube.com/watch?v=${YTMusicStore.track.id}`,
                        duration: YTMusicStore.track.duration,
                        isPlaying: YTMusicStore.isPlaying,
                        volume: YTMusicStore.volume,
                        shuffle: YTMusicStore.shuffle,
                        repeat,
                        nextRepeat,
                        repeatClassName,
                        accentColor: "#ff0033",
                    };
                }
                return null;
            };

            const spotify = buildSpotify();
            const sc      = buildSC();
            const ytm     = buildYTM();

            const anyPlaying = !!(spotify?.isPlaying || sc?.isPlaying || ytm?.isPlaying);

            // Manual override: only stick when the override source itself is playing,
            // or when nothing is playing at all.  If a different source is actively
            // playing we auto-switch so the UI always shows what is currently heard.
            if (_manualOverride !== null) {
                const overrideData =
                    _manualOverride === "spotify"    ? spotify :
                    _manualOverride === "soundcloud" ? sc      :
                    _manualOverride === "ytmusic"    ? ytm     : null;
                if (overrideData && (!anyPlaying || overrideData.isPlaying)) return overrideData;
            }

            // Record the most recently active source for stable paused fallback
            if (spotify?.isPlaying) _lastPlayingSource = "spotify";
            else if (sc?.isPlaying)  _lastPlayingSource = "soundcloud";
            else if (ytm?.isPlaying) _lastPlayingSource = "ytmusic";

            // Prefer actively playing source; Spotify always wins over SC/YTM.
            if (anyPlaying) {
                if (spotify?.isPlaying) return spotify;
                const priority = Settings.plugins.MusicControls.presencePriority ?? "sc_ytm";
                if (priority === "ytm_sc") {
                    if (ytm?.isPlaying) return ytm;
                    if (sc?.isPlaying)  return sc;
                } else {
                    if (sc?.isPlaying)  return sc;
                    if (ytm?.isPlaying) return ytm;
                }
            }

            // Fallback when paused: prefer the most recently played source so
            // the UI doesn't jump around when sources briefly report not-playing
            // during track transitions.
            if (_lastPlayingSource) {
                const last = _lastPlayingSource === "spotify" ? spotify
                           : _lastPlayingSource === "soundcloud" ? sc : ytm;
                if (last) return last;
            }

            // Last resort: any source with a track, priority order
            if (spotify) return spotify;
            const priority = Settings.plugins.MusicControls.presencePriority ?? "sc_ytm";
            if (priority === "ytm_sc") {
                if (ytm) return ytm;
                if (sc)  return sc;
            } else {
                if (sc)  return sc;
                if (ytm) return ytm;
            }
            return null;
        },
        null,
        // Equality: re-render only when displayed values actually change
        (prev, next) => {
            if (prev === next) return true;
            if (!prev || !next) return false;
            return (
                prev.source === next.source &&
                prev.title === next.title &&
                prev.artist === next.artist &&
                prev.thumbnail === next.thumbnail &&
                prev.isPlaying === next.isPlaying &&
                prev.volume === next.volume &&
                prev.shuffle === next.shuffle &&
                prev.repeat === next.repeat &&
                prev.accentColor === next.accentColor
            );
        }
    );
}

// ── Stable control dispatchers ────────────────────────────────────────────────
// These read the current active source at call-time — not reactive.

function unifiedRepeatToYTM(r: "off" | "context" | "track"): "NONE" | "ALL" | "ONE" {
    if (r === "context") return "ALL";
    if (r === "track")   return "ONE";
    return "NONE";
}

export const MusicControls = {
    _getTarget() {
        const spotifyActive = !!(SpotifyStore.track && SpotifyStore.device?.is_active);
        const anyPlaying =
            (spotifyActive && SpotifyStore.isPlaying) ||
            (SCStore.track && SCStore.isPlaying) ||
            (YTMusicStore.track && YTMusicStore.isPlaying);

        // Override only sticks when the override source is playing or nothing is playing
        if (_manualOverride !== null) {
            const overridePlaying =
                (_manualOverride === "spotify"    && spotifyActive         && SpotifyStore.isPlaying) ||
                (_manualOverride === "soundcloud" && SCStore.track        && SCStore.isPlaying)       ||
                (_manualOverride === "ytmusic"    && YTMusicStore.track   && YTMusicStore.isPlaying);
            if (!anyPlaying || overridePlaying) {
                if (_manualOverride === "spotify"    && spotifyActive)       return SpotifyStore;
                if (_manualOverride === "soundcloud" && SCStore.track)       return SCStore;
                if (_manualOverride === "ytmusic"    && YTMusicStore.track)  return YTMusicStore;
            }
        }

        // Actively playing — Spotify wins, then priority setting
        if (spotifyActive && SpotifyStore.isPlaying) return SpotifyStore;
        const priority = Settings.plugins.MusicControls.presencePriority ?? "sc_ytm";
        if (priority === "ytm_sc") {
            if (YTMusicStore.track && YTMusicStore.isPlaying) return YTMusicStore;
            if (SCStore.track      && SCStore.isPlaying)      return SCStore;
        } else {
            if (SCStore.track      && SCStore.isPlaying)      return SCStore;
            if (YTMusicStore.track && YTMusicStore.isPlaying) return YTMusicStore;
        }

        // Fallback: paused sources
        if (spotifyActive)       return SpotifyStore;
        if (SCStore.track)       return SCStore;
        if (YTMusicStore.track)  return YTMusicStore;
        return null;
    },

    getPosition(): number { return this._getTarget()?.position ?? 0; },
    setPlaying(v: boolean) { this._getTarget()?.setPlaying(v); },
    next() { this._getTarget()?.next(); },
    prev() {
        const target = this._getTarget();
        if (!target) return;
        if (Settings.plugins.MusicControls.previousButtonRestartsTrack && target.position > 3000)
            target.seek(0);
        else
            target.prev();
    },
    seek(ms: number) { this._getTarget()?.seek(ms); },
    setVolume(v: number) { this._getTarget()?.setVolume(v); },
    setShuffle(v: boolean) { this._getTarget()?.setShuffle(v); },
    setRepeat(r: "off" | "context" | "track") {
        const target = this._getTarget();
        if (!target) return;
        if (target === SpotifyStore) return target.setRepeat(r);
        return target.setRepeat(unifiedRepeatToYTM(r) as any);
    },
    openExternal() {
        const target = this._getTarget();
        if (target === SpotifyStore) return target.openExternal(`/track/${SpotifyStore.track.id}`);
        if (target === SCStore) return SCStore.openInSoundCloud();
        if (target === YTMusicStore) return YTMusicStore.openInYTMusic();
    },
};

