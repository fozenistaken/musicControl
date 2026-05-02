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

import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

declare const VencordNative: {
    native: { openExternal(url: string): void; };
    pluginHelpers: {
        MusicControls: {
            getSCState(): Promise<{ _ts: number; [key: string]: any; } | null>;
            queueSCControl(action: string, value?: number): Promise<void>;
        };
    };
};

export interface SCTrack {
    id: string;
    title: string;
    artist: string;
    duration: number;           // ms
    thumbnail: string;          // base64 data URL (CSP-safe for the img element)
    thumbnailOriginal?: string; // original CDN URL (for Discord Rich Presence)
    permalink: string;          // full URL to the track on SC
}

export type SCRepeatState = "NONE" | "ONE" | "ALL";

interface SCState {
    track: SCTrack | null;
    isPlaying: boolean;
    position: number;
    volume: number;
    shuffle: boolean;
    repeat: SCRepeatState;
}

export const SC_DISPATCH_TYPE = "MC_SOUNDCLOUD_STATE_UPDATE";

// ── Polling ───────────────────────────────────────────────────────────────────
// Always dispatch on every tick so isSettingPosition resets reliably.
// Recursive setTimeout prevents overlapping ticks on slow IPC.
// Adaptive delay: 150 ms playing, 1000 ms paused/no track.

let _scStop = false;

export function startSCPolling(dispatch: typeof FluxDispatcher) {
    _scStop = false;

    const tick = async () => {
        if (_scStop) return;
        try {
            const data = await VencordNative.pluginHelpers.MusicControls.getSCState() as SCState | null;
            const alive = data && Date.now() - data._ts < 10_000 ? data : null;
            dispatch.dispatch({ type: SC_DISPATCH_TYPE, data: alive });
            setTimeout(tick, alive?.isPlaying ? 150 : 1000);
        } catch {
            if (!_scStop) setTimeout(tick, 500);
        }
    };

    tick();
}

export function stopSCPolling() {
    _scStop = true;
}

// ── Flux Store ────────────────────────────────────────────────────────────────

export const SCStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    class SCStore extends (Store as any) {
        declare emitChange: () => void;

        public mPosition = 0;
        public _start = 0;
        public isSettingPosition = false;

        public track: SCTrack | null = null;
        public isPlaying = false;
        public repeat: SCRepeatState = "NONE";
        public shuffle = false;
        public volume = 100;

        public get position(): number {
            let pos = this.mPosition;
            if (this.isPlaying) pos += Date.now() - this._start;
            return pos;
        }

        public set position(p: number) {
            this.mPosition = p;
            this._start = Date.now();
        }

        openInSoundCloud() {
            if (this.track?.permalink)
                VencordNative.native.openExternal(this.track.permalink);
        }

        setPlaying(playing: boolean) { this._send(playing ? "PLAY" : "PAUSE"); }
        next() { this._send("NEXT"); }
        prev() { this._send("PREVIOUS"); }

        seek(ms: number) {
            if (this.isSettingPosition) return;
            this.isSettingPosition = true;
            this._send("SEEK", Math.round(ms));
        }

        setVolume(v: number) {
            this._send("VOLUME", Math.round(v));
            this.volume = v;
            this.emitChange();
        }

        setShuffle(state: boolean) { this._send("SHUFFLE", state ? 1 : 0); }
        setRepeat(state: SCRepeatState) { this._send("REPEAT", state === "NONE" ? 0 : state === "ALL" ? 1 : 2); }

        _send(action: string, value?: number) {
            VencordNative.pluginHelpers.MusicControls.queueSCControl(action, value);
        }
    }

    const store = new SCStore(FluxDispatcher, {
        [SC_DISPATCH_TYPE]({ data }: { data: SCState | null; }) {
            if (!data) {
                store.track = null;
                store.isPlaying = false;
                store.isSettingPosition = false;
                store.emitChange();
                return;
            }
            store.track = data.track ?? null;
            store.isPlaying = data.isPlaying ?? false;
            store.volume = data.volume ?? 100;
            store.repeat = data.repeat ?? "NONE";
            store.shuffle = data.shuffle ?? false;
            store.position = data.position ?? 0;
            store.isSettingPosition = false;
            store.emitChange();
        }
    });

    return store;
});
