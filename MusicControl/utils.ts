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

import { FluxDispatcher } from "@webpack/common";

export function shallowEqual(a: Record<string, any> | null, b: Record<string, any> | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

export interface PolledState {
    track: object | null;
    isPlaying: boolean;
    position: number;
    volume: number;
    shuffle: boolean;
    repeat: "NONE" | "ONE" | "ALL";
}

interface PolledStore {
    track: object | null;
    isPlaying: boolean;
    position: number;
    volume: number;
    shuffle: boolean;
    repeat: string;
    isSettingPosition: boolean;
    emitChange(): void;
}

// Applies a polled state to a store and only emits when something visible changed.
// Position is interpolated by the store getter, so it's updated silently.
export function applyPolledState(store: PolledStore, data: PolledState | null) {
    store.isSettingPosition = false;

    if (!data) {
        if (!store.track && !store.isPlaying) return;
        store.track = null;
        store.isPlaying = false;
        store.emitChange();
        return;
    }

    const track = data.track ?? null;
    const isPlaying = data.isPlaying ?? false;
    const volume = data.volume ?? 100;
    const repeat = data.repeat ?? "NONE";
    const shuffle = data.shuffle ?? false;
    store.position = data.position ?? 0;

    const changed = !shallowEqual(store.track, track)
        || store.isPlaying !== isPlaying
        || store.volume !== volume
        || store.repeat !== repeat
        || store.shuffle !== shuffle;
    if (!changed) return;

    // Keep the old track object when equal so reference checks downstream stay cheap
    if (!shallowEqual(store.track, track)) store.track = track;
    store.isPlaying = isPlaying;
    store.volume = volume;
    store.repeat = repeat;
    store.shuffle = shuffle;
    store.emitChange();
}

// Polls the native helper for a browser-extension source.
// Recursive setTimeout so slow IPC never overlaps ticks; the generation counter
// makes a stale chain die if the plugin is restarted while a tick is in flight.
// Adaptive delay: 150 ms playing, 1000 ms paused/no track, 500 ms after an error.
export function createPoller(type: string, getState: () => Promise<(PolledState & { _ts: number; }) | null>) {
    let generation = 0;

    return {
        start() {
            const gen = ++generation;
            const tick = async () => {
                if (gen !== generation) return;
                let delay = 500;
                try {
                    const data = await getState();
                    if (gen !== generation) return;
                    const alive = data && Date.now() - data._ts < 10_000 ? data : null;
                    FluxDispatcher.dispatch({ type, data: alive });
                    delay = alive?.isPlaying ? 150 : 1000;
                } catch { }
                setTimeout(tick, delay);
            };
            tick();
        },
        stop() {
            generation++;
        }
    };
}
