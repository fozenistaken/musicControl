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

import "./styles.css";

import { Flex } from "@components/Flex";
import { CopyIcon, LinkIcon, OpenExternalIcon } from "@components/Icons";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { ContextMenuApi, Menu, React, useEffect, useState, useStateFromStores } from "@webpack/common";

import { getSourceOverride, MusicControls, MusicData, MusicSource, setSourceOverride, useMusicData } from "./MusicStore";
import { SCStore } from "./SCStore";
import { SpotifyStore } from "./SpotifyStore";
import { YTMusicStore } from "./YTMusicStore";

const cl = classNameFactory("vc-mc-");


// ── SVG Icons ─────────────────────────────────────────────────────────────────

function Svg(path: string, label: string) {
    return () => (
        <svg className={cl("button-icon", label)} height="24" width="24" viewBox="0 0 24 24" fill="currentColor" aria-label={label} focusable={false}>
            <path d={path} />
        </svg>
    );
}

const PlayButton  = Svg("M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z", "play");
const PauseButton = Svg("M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z", "pause");
const SkipPrev    = Svg("M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.57.4-.57 1.24 0 1.64z", "previous");
const SkipNext    = Svg("M7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z", "next");
const RepeatIcon  = Svg("M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1V7zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.31.31.85.09.85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1v3z", "repeat");
const ShuffleIcon = Svg("M10.59 9.17L6.12 4.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.46 4.46 1.42-1.4zm4.76-4.32l1.19 1.19L4.7 17.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L17.96 7.46l1.19 1.19c.31.31.85.09.85-.36V4.5c0-.28-.22-.5-.5-.5h-3.79c-.45 0-.67.54-.36.85zm-.52 8.56l-1.41 1.41 3.13 3.13-1.2 1.2c-.31.31-.09.85.36.85h3.79c.28 0 .5-.22.5-.5v-3.79c0-.45-.54-.67-.85-.35l-1.19 1.19-3.13-3.14z", "shuffle");
const VolumeUp    = Svg("M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z", "volume");
const VolumeOff   = Svg("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z", "mute");

// ── Source badge SVGs ─────────────────────────────────────────────────────────
// Tiny icons shown in the bottom-right of the album art

function SourceBadge({ source }: { source: MusicData["source"]; }) {
    if (source === "spotify") return (
        <svg className={cl("source-badge")} viewBox="0 0 24 24" fill="currentColor" aria-label="Spotify">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
        </svg>
    );
    if (source === "soundcloud") return (
        <svg className={cl("source-badge")} viewBox="0 0 24 24" fill="currentColor" aria-label="SoundCloud">
            <path d="M1.175 12.225c-.017 0-.032.001-.047.003A.27.27 0 0 0 .9 12.4l-.3 1.6.3 1.562a.27.27 0 0 0 .228.172c.016.002.031.003.047.003.13 0 .237-.097.255-.226L1.75 14l-.32-1.51a.258.258 0 0 0-.255-.265zm1.908-.376c-.022 0-.043.002-.065.006a.316.316 0 0 0-.263.21l-.34 2.135.34 2.073a.316.316 0 0 0 .328.266.316.316 0 0 0 .328-.266l.385-2.073L3.45 12.07a.316.316 0 0 0-.368-.221zm1.94-.48c-.026 0-.053.002-.08.008a.37.37 0 0 0-.302.254l-.376 2.57.376 2.46a.37.37 0 0 0 .382.32.37.37 0 0 0 .382-.32l.427-2.46-.427-2.57a.37.37 0 0 0-.382-.262zm14.576-1.06a3.573 3.573 0 0 0-.706.07 5.01 5.01 0 0 0-9.94 1.036v7.13h10.646a2.674 2.674 0 0 0 0-5.348 2.65 2.65 0 0 0-.706.095 3.57 3.57 0 0 0 .706-3.983z" />
        </svg>
    );
    return (
        <svg className={cl("source-badge")} viewBox="0 0 24 24" fill="currentColor" aria-label="YouTube Music">
            <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm-2 16.5v-9l6 4.5-6 4.5z" />
        </svg>
    );
}

// ── Source Selector (hover dropdown on badge) ─────────────────────────────────


function SourceSelector({ active }: { active: MusicData["source"]; }) {
    const override = useStateFromStores([SpotifyStore, SCStore, YTMusicStore], getSourceOverride);
    const src = override ?? active;
    if (!src) return null;
    const label = src === "spotify" ? "Spotify" : src === "soundcloud" ? "SoundCloud" : "YouTube Music";
    return (
        <div className={cl("source-indicator")} title={label}>
            <SourceBadge source={src} />
        </div>
    );
}

// ── Shared Button ─────────────────────────────────────────────────────────────

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button className={cl("button")} {...props}>{props.children}</button>;
}

// ── Controls Row ──────────────────────────────────────────────────────────────

function Controls({ data }: { data: MusicData; }) {
    return (
        <Flex className={cl("button-row")} gap="0">
            <Button
                className={classes(cl("button"), cl("shuffle"), cl(data.shuffle ? "shuffle-on" : "shuffle-off"))}
                onClick={() => MusicControls.setShuffle(!data.shuffle)}
            >
                <ShuffleIcon />
            </Button>
            <Button onClick={() => MusicControls.prev()}>
                <SkipPrev />
            </Button>
            <Button onClick={() => MusicControls.setPlaying(!data.isPlaying)}>
                {data.isPlaying ? <PauseButton /> : <PlayButton />}
            </Button>
            <Button onClick={() => MusicControls.next()}>
                <SkipNext />
            </Button>
            <Button
                className={classes(cl("button"), cl("repeat"), cl(data.repeatClassName))}
                onClick={() => MusicControls.setRepeat(data.nextRepeat)}
                style={{ position: "relative" }}
            >
                {data.repeat === "track" && <span className={cl("repeat-1")}>1</span>}
                <RepeatIcon />
            </Button>
        </Flex>
    );
}

// ── Volume Bar ────────────────────────────────────────────────────────────────

function VolumeBar({ data }: { data: MusicData; }) {
    const storeVolume = useStateFromStores(
        [SpotifyStore, SCStore, YTMusicStore],
        () => {
            if (data.source === "spotify") return SpotifyStore.volume;
            if (data.source === "soundcloud") return SCStore.volume;
            return YTMusicStore.volume;
        }
    ) ?? 100;

    const [localVolume, setLocalVolume] = useState(storeVolume);
    const [lastVolume, setLastVolume]   = useState(storeVolume > 0 ? storeVolume : 100);

    useEffect(() => {
        setLocalVolume(storeVolume);
        if (storeVolume > 0) setLastVolume(storeVolume);
    }, [storeVolume]);

    const onRelease = (v: number) => { if (v > 0) setLastVolume(v); MusicControls.setVolume(v); };

    const toggleMute = () => {
        if (localVolume === 0) { setLocalVolume(lastVolume); MusicControls.setVolume(lastVolume); }
        else                   { setLocalVolume(0);          MusicControls.setVolume(0); }
    };

    // Use the literal accent color (e.g. "#ff5500") so it's resolved at render time,
    // not via CSS cascade which can lag when switching sources.
    const accent = data.accentColor;

    return (
        <div className={cl("volume-bar-col")}>
            <Button className={cl("volume-button")} onClick={toggleMute}>
                {localVolume === 0 ? <VolumeOff /> : <VolumeUp />}
            </Button>
            <div className={cl("volume-slider-container")}>
                <input
                    type="range" min="0" max="100" value={localVolume}
                    onInput={(e: React.ChangeEvent<HTMLInputElement>) => setLocalVolume(Number(e.currentTarget.value))}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onRelease(Number(e.currentTarget.value))}
                    className={cl("native-volume-slider")}
                    style={{ background: `linear-gradient(to right, ${accent} ${localVolume}%, #4f545c ${localVolume}%)` }}
                />
            </div>
        </div>
    );
}


// ── Context Menus ─────────────────────────────────────────────────────────────

function TrackContextMenu({ data }: { data: MusicData; }) {
    const volume = useStateFromStores([SpotifyStore, SCStore, YTMusicStore], () => data.source === "spotify" ? SpotifyStore.volume : data.source === "soundcloud" ? SCStore.volume : YTMusicStore.volume);
    return (
        <Menu.Menu navId="vc-mc-track-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Track Menu">
            <Menu.MenuItem id="vc-mc-copy-title" label="Copy Song Title" action={() => copyWithToast(data.title)} icon={CopyIcon} />
            <Menu.MenuItem id="vc-mc-copy-link"  label="Copy Link"       action={() => copyWithToast(data.openUrl)} icon={LinkIcon} />
            <Menu.MenuItem id="vc-mc-open"        label={`Open in ${data.source === "spotify" ? "Spotify" : data.source === "soundcloud" ? "SoundCloud" : "YouTube Music"}`} action={() => MusicControls.openExternal()} icon={OpenExternalIcon} />
            <Menu.MenuControlItem id="vc-mc-volume" key="vc-mc-volume" label="Volume"
                control={(props: any, ref: any) => (
                    <Menu.MenuSliderControl {...props} ref={ref} value={volume} minValue={0} maxValue={100} onChange={debounce((v: number) => MusicControls.setVolume(v))} />
                )}
            />
        </Menu.Menu>
    );
}

// ── Main Player ───────────────────────────────────────────────────────────────

export function Player() {
    const data = useMusicData();

    const isPlayingRaw = useStateFromStores(
        [SpotifyStore, SCStore, YTMusicStore],
        () => SpotifyStore.isPlaying || SCStore.isPlaying || YTMusicStore.isPlaying
    );

    const [shouldHide, setShouldHide] = useState(false);

    React.useEffect(() => {
        setShouldHide(false);
        if (!isPlayingRaw) {
            const t = setTimeout(() => setShouldHide(true), 1000 * 60 * 5);
            return () => clearTimeout(t);
        }
    }, [isPlayingRaw]);

    if (!data || shouldHide) return null;

    const accentStyle = { "--vc-mc-accent": data.accentColor } as React.CSSProperties;

    return (
        <div className={cl("position-anchor")}>
            <div id={cl("player")} style={accentStyle}>
                <div className={cl("horizontal-layout-wrapper")}>

                    {/* Left: Album Art */}
                    <div className={cl("album-col")}>
                        {data.thumbnail && (
                            <div className={cl("album-image-wrap")}>
                                <img
                                    id={cl("album-image")}
                                    src={data.thumbnail}
                                    alt="Album Art"
                                    onClick={() => MusicControls.openExternal()}
                                    onContextMenu={(e: any) =>
                                        ContextMenuApi.openContextMenu(e, () => <TrackContextMenu data={data} />)
                                    }
                                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                        // YTM fallback: maxresdefault → hqdefault
                                        const img = e.currentTarget;
                                        if (img.src.includes("maxresdefault"))
                                            img.src = img.src.replace("maxresdefault", "hqdefault");
                                    }}
                                />
                                <SourceSelector active={data.source} />
                            </div>
                        )}
                    </div>

                    {/* Middle: Title + Controls */}
                    <div className={cl("middle-content-col")}>
                        <div className={cl("titles-wrapper")}>
                            <div
                                id={cl("song-title")}
                                className={cl("ellipoverflow")}
                                title={data.title}
                                role="link"
                                onClick={() => MusicControls.openExternal()}
                                onContextMenu={(e: any) =>
                                    ContextMenuApi.openContextMenu(e, () => <TrackContextMenu data={data} />)
                                }
                            >
                                {data.title}
                            </div>
                            {data.artist && (
                                <div className={cl("artist-name")} title={data.artist}>
                                    {data.artist}
                                </div>
                            )}
                        </div>
                        <div className={cl("hover-playback-controls")}>
                            <Controls data={data} />
                        </div>
                    </div>

                    {/* Right: Volume */}
                    <div className={cl("volume-col")}>
                        <VolumeBar data={data} />
                    </div>

                </div>
            </div>
        </div>
    );
}
