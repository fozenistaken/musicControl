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

// Runs in the Electron main process (full Node.js).
// Exposes functions via VencordNative.pluginHelpers.MusicControls

import { IpcMainInvokeEvent, utilityProcess } from "electron";
import http from "http";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── HTTP state servers ────────────────────────────────────────────────────────

interface TrackState {
    track: object | null;
    isPlaying: boolean;
    position: number;
    volume: number;
    shuffle: boolean;
    repeat: string;
    _ts: number;
    [key: string]: any;
}

interface PendingControl {
    action: string;
    value?: number;
    _ts: number;
}

const CONTROL_TTL_MS = 1200;

interface ServerSlot {
    server: http.Server | null;
    latestState: TrackState | null;
    pendingControl: PendingControl | null;
    port: number;
    label: string;
}

const slots: Record<"ytm" | "sc", ServerSlot> = {
    ytm: { server: null, latestState: null, pendingControl: null, port: 8547, label: "YTM" },
    sc:  { server: null, latestState: null, pendingControl: null, port: 8548, label: "SoundCloud" },
};

function setCors(res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function startSlot(slot: ServerSlot) {
    if (slot.server) return;

    slot.server = http.createServer((req, res) => {
        setCors(res);
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.method !== "POST" || req.url !== "/state") { res.writeHead(404); res.end(); return; }

        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body);
                slot.latestState = parsed ? { ...parsed, _ts: Date.now() } : null;

                let control: { action: string; value?: number; } | null = null;
                if (slot.pendingControl) {
                    const { _ts, ...cmd } = slot.pendingControl;
                    slot.pendingControl = null;
                    if (Date.now() - _ts <= CONTROL_TTL_MS) control = cmd;
                    else console.warn(`[MusicControls] Discarded stale ${cmd.action} (${Date.now() - _ts}ms old)`);
                }

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ control }));
            } catch { res.writeHead(400); res.end(); }
        });
    });

    slot.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE")
            console.error(`[MusicControls] Port ${slot.port} already in use (${slot.label})`);
    });

    slot.server.listen(slot.port, "127.0.0.1");
}

function stopSlot(slot: ServerSlot) {
    slot.server?.close();
    slot.server = null;
    slot.latestState = null;
    slot.pendingControl = null;
}

// ── Discord RPC worker ────────────────────────────────────────────────────────
// KEY INSIGHT: native.ts runs inside Discord's own Electron main process.
// Any socket we open from here has Discord's OWN PID — Discord's RPC server
// ignores SET_ACTIVITY from self-connections (same reason you can't RPC into
// yourself). The fix: spawn a SEPARATE child process via utilityProcess.fork()
// so the connection comes from an independent PID, exactly like discord-vscode
// and soundcloud-rpc do from their respective host processes.

// Worker script — written to disk and run by Electron's utility process.
// Uses process.parentPort (Electron IPC) to receive activity from native.ts.
// Uses Node.js net module to connect to Discord's IPC named pipe and send
// the real SET_ACTIVITY command that is visible to other users.
const WORKER_LINES = [
    "const net = require('net');",
    "let sock = null, ready = false, pending = undefined;",
    "let activeId = '', rxBuf = Buffer.alloc(0), retryTimer = null;",
    "",
    "// Build the Windows named pipe path without backslash escape headaches",
    "function pipePath(id) {",
    "  if (process.platform === 'win32') {",
    "    const s = String.fromCharCode(92); // backslash",
    "    return s + s + '.' + s + 'pipe' + s + 'discord-ipc-' + id;",
    "  }",
    "  const tmp = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';",
    "  return tmp + '/discord-ipc-' + id;",
    "}",
    "",
    "function frame(op, data) {",
    "  const s = JSON.stringify(data);",
    "  const b = Buffer.allocUnsafe(8 + Buffer.byteLength(s, 'utf8'));",
    "  b.writeUInt32LE(op, 0);",
    "  b.writeUInt32LE(Buffer.byteLength(s, 'utf8'), 4);",
    "  b.write(s, 8, 'utf8');",
    "  return b;",
    "}",
    "",
    "function write(op, data) {",
    "  if (sock && sock.writable) try { sock.write(frame(op, data)); } catch(e) {}",
    "}",
    "",
    "function flush(activity) {",
    "  write(1, {",
    "    cmd: 'SET_ACTIVITY',",
    "    args: { pid: process.pid, activity: activity },",
    "    evt: null,",
    "    nonce: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)",
    "  });",
    "}",
    "",
    "function onData(chunk) {",
    "  rxBuf = Buffer.concat([rxBuf, chunk]);",
    "  while (rxBuf.length >= 8) {",
    "    const len = rxBuf.readUInt32LE(4);",
    "    if (rxBuf.length < 8 + len) break;",
    "    const op  = rxBuf.readUInt32LE(0);",
    "    const msg = rxBuf.subarray(8, 8 + len).toString('utf8');",
    "    rxBuf = rxBuf.subarray(8 + len);",
    "    if (op !== 1) continue;",
    "    try {",
    "      const p = JSON.parse(msg);",
    "      if (p.evt === 'READY') {",
    "        ready = true;",
    "        if (pending !== undefined) { flush(pending); pending = undefined; }",
    "      }",
    "    } catch(e) {}",
    "  }",
    "}",
    "",
    "function connect(id) {",
    "  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }",
    "  if (sock) { try { sock.destroy(); } catch(e) {} sock = null; }",
    "  ready = false; rxBuf = Buffer.alloc(0); activeId = id;",
    "  let n = 0;",
    "  function tryNext() {",
    "    if (n > 9) {",
    "      retryTimer = setTimeout(function() { connect(activeId); }, 15000);",
    "      return;",
    "    }",
    "    const s = net.createConnection(pipePath(n++));",
    "    s.once('connect', function() {",
    "      sock = s;",
    "      s.on('data', onData);",
    "      s.on('close', function() {",
    "        if (sock === s) { sock = null; ready = false; }",
    "        if (!retryTimer)",
    "          retryTimer = setTimeout(function() { connect(activeId); }, 15000);",
    "      });",
    "      write(0, { v: 1, client_id: id });",
    "    });",
    "    s.once('error', tryNext);",
    "  }",
    "  tryNext();",
    "}",
    "",
    "function handle(m) {",
    "  if (!m) return;",
    "  const cid = m.clientId || '';",
    "  if (!cid) {",
    "    if (ready) flush(null); else pending = null;",
    "    return;",
    "  }",
    "  if (cid !== activeId || !sock) { pending = m.activity; connect(cid); }",
    "  else if (ready) flush(m.activity);",
    "  else pending = m.activity;",
    "}",
    "",
    "// Receive activity messages from the parent (Electron utilityProcess IPC)",
    "if (process.parentPort) {",
    "  process.parentPort.on('message', function(event) { handle(event.data); });",
    "  process.parentPort.start();",
    "}",
];

const WORKER_CODE = WORKER_LINES.join("\n");
const WORKER_PATH = join(tmpdir(), "mc_rpc_worker.js");

let rpcProc: Electron.UtilityProcess | null = null;
let workerFileWritten = false;

function ensureRPCWorker(): Electron.UtilityProcess | null {
    if (rpcProc) return rpcProc;

    // Write worker script to temp dir (overwrite on each plugin start so
    // the file is always up-to-date with the current worker code).
    if (!workerFileWritten) {
        try {
            writeFileSync(WORKER_PATH, WORKER_CODE, "utf8");
            workerFileWritten = true;
        } catch (e) {
            console.error("[MusicControls/RPC] Failed to write worker file:", e);
            return null;
        }
    }

    try {
        rpcProc = utilityProcess.fork(WORKER_PATH);
        rpcProc.on("exit", () => {
            console.log("[MusicControls/RPC] Worker exited");
            rpcProc = null;
        });
        console.log("[MusicControls/RPC] Worker spawned (pid separate from Discord)");
        return rpcProc;
    } catch (e) {
        console.error("[MusicControls/RPC] utilityProcess.fork failed:", e);
        return null;
    }
}

function stopRPCWorker() {
    if (!rpcProc) return;
    try { rpcProc.postMessage({ clientId: "", activity: null }); } catch { }
    setTimeout(() => { rpcProc?.kill(); rpcProc = null; }, 300);
}

// ── Exported IPC functions ────────────────────────────────────────────────────

export function start(_e: IpcMainInvokeEvent): void {
    startSlot(slots.ytm);
    startSlot(slots.sc);
}

export function stop(_e: IpcMainInvokeEvent): void {
    stopSlot(slots.ytm);
    stopSlot(slots.sc);
    stopRPCWorker();
}

export function getYTMState(_e: IpcMainInvokeEvent): TrackState | null {
    return slots.ytm.latestState;
}

export function getSCState(_e: IpcMainInvokeEvent): TrackState | null {
    return slots.sc.latestState;
}

export function queueYTMControl(_e: IpcMainInvokeEvent, action: string, value?: number): void {
    slots.ytm.pendingControl = { action, value, _ts: Date.now() };
}

export function queueSCControl(_e: IpcMainInvokeEvent, action: string, value?: number): void {
    slots.sc.pendingControl = { action, value, _ts: Date.now() };
}

export function setRPCActivity(_e: IpcMainInvokeEvent, clientId: string, activity: object | null): void {
    const proc = ensureRPCWorker();
    if (!proc) return;
    try {
        proc.postMessage({ clientId: clientId || "", activity });
    } catch (e) {
        console.error("[MusicControls/RPC] postMessage failed:", e);
        rpcProc = null; // force respawn next call
    }
}
