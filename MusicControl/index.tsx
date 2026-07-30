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

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

import { Player } from "./PlayerComponent";
import { startPresence, stopPresence, updatePresence } from "./PresenceService";
import { SC_DISPATCH_TYPE, startSCPolling, stopSCPolling } from "./SCStore";
import { YTM_DISPATCH_TYPE, startYTMPolling, stopYTMPolling } from "./YTMusicStore";

declare const VencordNative: {
    pluginHelpers: {
        MusicControls: {
            start(): Promise<void>;
            stop(): Promise<void>;
            setRPCActivity(clientId: string, activity: object | null): Promise<void>;
        };
    };
};

export default definePlugin({
    name: "MusicControls",
    description: "Unified music player above the account panel — supports Spotify, SoundCloud, and YouTube Music. Priority: Spotify → SoundCloud → YouTube Music. Requires the companion browser extension for SoundCloud and YouTube Music.",
    authors: [{ name: "fozen", id: 420965304441765888n }],

    options: {
        useSpotifyUris: {
            type: OptionType.BOOLEAN,
            description: "Open Spotify URIs instead of URLs. Requires Spotify to be installed.",
            default: false
        },
        previousButtonRestartsTrack: {
            type: OptionType.BOOLEAN,
            description: "Pressing previous within 3 seconds of a track starting goes to the previous track. After 3 seconds it restarts the current one.",
            default: true
        },
        enablePresence: {
            type: OptionType.BOOLEAN,
            description: "Show \"Listening to SoundCloud / YouTube Music\" on your Discord profile. Spotify is handled natively by Discord.",
            default: true,
            onChange: () => updatePresence()
        },
        presencePriority: {
            type: OptionType.SELECT,
            description: "If both SoundCloud and YouTube Music are playing at the same time, which one shows on your profile?",
            options: [
                { label: "SoundCloud → YouTube Music", value: "sc_ytm", default: true },
                { label: "YouTube Music → SoundCloud", value: "ytm_sc" },
            ],
            onChange: () => updatePresence()
        },
    },

    patches: [
        // ── Inject Player above the account panel ────────────────────────────
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/,
                replace: "$self.PanelWrapper,{VencordOriginal:$1,"
            }
        },

        // ── Expose SpotifyAPI POST method + vcSpotifyMarker ──────────────────
        {
            find: ".PLAYER_DEVICES",
            replacement: [{
                match: /get:(\i)\.bind\(null,(\i\.\i)\.get\)/,
                replace: "post:$1.bind(null,$2.post),vcSpotifyMarker:1,$&"
            }, {
                // Prevent 202 double-request bug
                match: /202===\i\.status/,
                replace: "false",
            }]
        },

        // ── Expose shuffle + actual repeat state from Spotify events ─────────
        {
            find: 'repeat:"off"!==',
            replacement: [
                {
                    match: /repeat:"off"!==(\i),/,
                    replace: "shuffle:arguments[2]?.shuffle_state??false,actual_repeat:$1,$&"
                },
                {
                    match: /(?<=artists.filter\(\i=\>).{0,10}\i\.id\)\&\&/,
                    replace: ""
                }
            ]
        },
    ],

    async start() {
        const tryStart = async () => {
            try {
                await VencordNative.pluginHelpers.MusicControls.start();
            } catch (e) {
                console.error("[MusicControls] Native start failed, retrying in 2s:", e);
                setTimeout(tryStart, 2000);
                return;
            }
            startYTMPolling(FluxDispatcher);
            startSCPolling(FluxDispatcher);
            startPresence();
        };
        tryStart();
    },

    stop() {
        stopYTMPolling();
        stopSCPolling();
        stopPresence();
        FluxDispatcher.dispatch({ type: YTM_DISPATCH_TYPE, data: null });
        FluxDispatcher.dispatch({ type: SC_DISPATCH_TYPE, data: null });
        VencordNative.pluginHelpers.MusicControls.stop();
    },

    PanelWrapper({ VencordOriginal, ...props }) {
        return (
            <>
                <ErrorBoundary
                    key="vc-mc"
                    fallback={() => (
                        <div className="vc-mc-fallback">
                            <p>Failed to render MusicControls :(</p>
                            <p>Check the console for errors</p>
                        </div>
                    )}
                >
                    <div className="vc-mc-position-anchor">
                        <Player />
                    </div>
                </ErrorBoundary>
                <VencordOriginal {...props} />
            </>
        );
    }
});
