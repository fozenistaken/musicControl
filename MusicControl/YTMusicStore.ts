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
            getYTMState(): Promise<{ _ts: number; [key: string]: any; } | null>;
            queueYTMControl(action: string, value?: number): Promise<void>;
        };
    };
};

export interface YTMTrack {
    id: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
}

export type YTMRepeatState = "NONE" | "ONE" | "ALL";

interface YTMState {
    track: YTMTrack | null;
    isPlaying: boolean;
    position: number;
    volume: number;
    shuffle: boolean;
    repeat: YTMRepeatState;
}

export const YTM_DISPATCH_TYPE = "MC_YTMUSIC_STATE_UPDATE";

// ── Polling ───────────────────────────────────────────────────────────────────
// Matches the original plugin exactly: always dispatch every tick so that
// isSettingPosition is always reset and controls always arrive promptly.
// Uses recursive setTimeout (not setInterval) so ticks never overlap even
// if the IPC round-trip is slow.
// Adaptive delay: 150 ms while playing, 1000 ms while paused/no track.

let _ytmStop = false;

export function startYTMPolling(dispatch: typeof FluxDispatcher) {
    _ytmStop = false;

    const tick = async () => {
        if (_ytmStop) return;
        try {
            const data = await VencordNative.pluginHelpers.MusicControls.getYTMState() as YTMState | null;
            const alive = data && Date.now() - data._ts < 10_000 ? data : null;
            dispatch.dispatch({ type: YTM_DISPATCH_TYPE, data: alive });
            setTimeout(tick, alive?.isPlaying ? 150 : 1000);
        } catch {
            if (!_ytmStop) setTimeout(tick, 500);
        }
    };

    tick();
}

export function stopYTMPolling() {
    _ytmStop = true;
}

// ── Flux Store ────────────────────────────────────────────────────────────────

export const YTMusicStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    class YTMusicStore extends (Store as any) {
        declare emitChange: () => void;

        public mPosition = 0;
        public _start = 0;
        public isSettingPosition = false;

        public track: YTMTrack | null = null;
        public isPlaying = false;
        public repeat: YTMRepeatState = "NONE";
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

        openInYTMusic() {
            if (this.track?.id)
                VencordNative.native.openExternal(`https://music.youtube.com/watch?v=${this.track.id}`);
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
        setRepeat(state: YTMRepeatState) { this._send("REPEAT", state === "NONE" ? 0 : state === "ALL" ? 1 : 2); }

        _send(action: string, value?: number) {
            VencordNative.pluginHelpers.MusicControls.queueYTMControl(action, value);
        }
    }

    const store = new YTMusicStore(FluxDispatcher, {
        [YTM_DISPATCH_TYPE]({ data }: { data: YTMState | null; }) {
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
