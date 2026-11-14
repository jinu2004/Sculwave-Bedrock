/**
 * Realm transport. Minecraft Realms cannot load @minecraft/server-net, so the addon
 * talks to a "bridge" process through a bot player that sits in the Realm:
 *
 *   addon --player.sendMessage--> bridge bot      (private chat line, only the bot receives it)
 *   addon <--/scriptevent sculwave:rx-- bridge bot (the bot must be a Realm operator)
 *
 * The bridge forwards the exact same HTTP / Socket.IO calls the direct transport makes, so
 * BackendConnection and the server are unchanged.
 */
import { world, system, Player } from '@minecraft/server';
import type { ScriptEventCommandMessageAfterEvent } from '@minecraft/server';
import { BackendConfig } from '../generated/config';
import { Emitter } from './emitter';
import type { BackendHttp, BackendHttpResponse, BackendSocket } from './types';
import {
    AddonMsg, BridgeMsg, PROTOCOL_VERSION, RX_EVENT_ID, SEP, TX_MARK,
    Reassembler, encodeFrames, parseFrame, randomId, toWire,
} from './codec';

export const TRANSPORT_KIND: "direct" | "realm" = "realm";

const BRIDGE_PROPERTY = "sculwave:bridgeGamertag";
const ALIVE_TIMEOUT_MS = 15_000;
const PING_EVERY_TICKS = 100;
const HELLO_EVERY_TICKS = 40;
const HTTP_TIMEOUT_TICKS = 200;
const CONNECT_TIMEOUT_TICKS = 200;
const TX_CHUNK = 1000;

interface PendingHttp {
    resolve: (r: BackendHttpResponse) => void;
    reject: (e: Error) => void;
    timer: number;
}

class RealmChannel {
    readonly sid = randomId();
    alive = false;
    socket: RealmSocket | undefined;

    private run = "";
    private lastRx = 0;
    private idCounter = 0;
    private httpCounter = 0;
    private tickCount = 0;
    private started = false;
    private warnedSender = false;
    private readonly reassembler = new Reassembler();
    private readonly pending = new Map<number, PendingHttp>();

    start(): void {
        if (this.started) return;
        this.started = true;
        system.runInterval(() => this.tick(), 20);
    }

    get bridgeName(): string {
        const stored = world.getDynamicProperty(BRIDGE_PROPERTY);
        const name = typeof stored === "string" && stored.trim() ? stored : BackendConfig.realmBridgeGamertag;
        return String(name ?? "").trim();
    }

    isBridge(playerName: string): boolean {
        const name = this.bridgeName.toLowerCase();
        return name !== "" && playerName.toLowerCase() === name;
    }

    private findBridge(): Player | undefined {
        const name = this.bridgeName.toLowerCase();
        if (!name) return undefined;
        return world.getAllPlayers().find((p) => p.name.toLowerCase() === name);
    }

    send(msg: AddonMsg): boolean {
        const bot = this.findBridge();
        if (!bot) return false;
        const frames = encodeFrames(this.sid, (++this.idCounter).toString(36), toWire(msg), TX_CHUNK);
        try {
            for (const frame of frames) bot.sendMessage(`${TX_MARK}${SEP}${frame}`);
            return true;
        } catch (error) {
            console.warn(`[sculwave] Failed to message bridge: ${error}`);
            return false;
        }
    }

    sendHello(): void {
        this.send({ t: "hello", v: PROTOCOL_VERSION });
    }

    private tick(): void {
        this.tickCount++;
        const now = Date.now();
        this.reassembler.sweep(now);

        if (this.alive && now - this.lastRx > ALIVE_TIMEOUT_MS) {
            this.markDead("bridge-timeout");
        }

        if (this.alive) {
            if (this.tickCount % (PING_EVERY_TICKS / 20) === 0) this.send({ t: "ping" });
        } else if (this.tickCount % (HELLO_EVERY_TICKS / 20) === 0) {
            this.sendHello();
        }
    }

    markDead(reason: string): void {
        const wasAlive = this.alive;
        this.alive = false;
        this.run = "";
        for (const [id, p] of this.pending) {
            system.clearRun(p.timer);
            p.reject(new Error(`Realm bridge lost (${reason})`));
            this.pending.delete(id);
        }
        this.socket?.lost(reason);
        if (wasAlive) console.warn(`[sculwave] Realm bridge offline: ${reason}`);
    }

    /** Returns true when the event belongs to the Realm channel (consumed). */
    handleScriptEvent(event: ScriptEventCommandMessageAfterEvent): boolean {
        if (event.id !== RX_EVENT_ID) return false;

        const sender = event.sourceEntity;
        if (!(sender instanceof Player) || !this.isBridge(sender.name)) {
            if (!this.warnedSender) {
                this.warnedSender = true;
                console.warn(`[sculwave] Ignored ${RX_EVENT_ID} from a sender that is not the configured bridge.`);
            }
            return true;
        }

        const now = Date.now();
        const frame = parseFrame(event.message);
        if (!frame || frame.sid !== this.sid) return true;

        const json = this.reassembler.push(frame, now);
        if (json === undefined) return true;

        let msg: BridgeMsg;
        try {
            msg = JSON.parse(json) as BridgeMsg;
        } catch {
            return true;
        }
        if (!msg || typeof msg.t !== "string") return true;

        this.lastRx = now;
        this.alive = true;
        this.dispatch(msg);
        return true;
    }

    private noteRun(run: string): void {
        if (this.run && this.run !== run) this.socket?.lost("bridge-restart");
        this.run = run;
    }

    private dispatch(msg: BridgeMsg): void {
        switch (msg.t) {
            case "ready":
                this.noteRun(String(msg.run));
                console.info("[sculwave] Realm bridge online.");
                return;
            case "pong":
                this.noteRun(String(msg.run));
                if (this.socket?.wantsConnected && !msg.sock) this.socket.lost("bridge-socket-down");
                return;
            case "http-res": {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                system.clearRun(p.timer);
                p.resolve({ status: Number(msg.status), body: String(msg.body) });
                return;
            }
            case "sio":
                this.socket?.onSio(msg.s, msg.r);
                return;
            case "ev":
                this.socket?.deliver(msg.ev, msg.d);
                return;
            case "evs":
                if (Array.isArray(msg.l)) for (const item of msg.l) this.socket?.deliver(item[0], item[1]);
                return;
        }
    }

    postJson(path: string, body: unknown): Promise<BackendHttpResponse> {
        if (!this.alive) return Promise.reject(new Error("Realm bridge is not reachable (is the bridge bot in the Realm?)"));
        return new Promise((resolve, reject) => {
            const id = ++this.httpCounter;
            const timer = system.runTimeout(() => {
                this.pending.delete(id);
                reject(new Error("Realm bridge HTTP timeout"));
            }, HTTP_TIMEOUT_TICKS);
            this.pending.set(id, { resolve, reject, timer });
            if (!this.send({ t: "http", id, path, body: JSON.stringify(body) })) {
                this.pending.delete(id);
                system.clearRun(timer);
                reject(new Error("Realm bridge bot is not in the world"));
            }
        });
    }
}

class RealmSocket extends Emitter implements BackendSocket {
    namespaceConnected = false;
    wantsConnected = false;
    private connectTimer: number | undefined;

    constructor(private readonly channel: RealmChannel, private readonly namespace: string) {
        super();
    }

    get isConnected(): boolean {
        return this.namespaceConnected && this.channel.alive;
    }

    async connect(): Promise<void> {
        if (this.isConnected || this.wantsConnected) return;
        if (!this.channel.alive) {
            throw new Error("Realm bridge is not reachable (is the bridge bot in the Realm?)");
        }
        this.channel.socket = this;
        this.wantsConnected = true;
        if (!this.channel.send({ t: "open", ns: this.namespace })) {
            this.wantsConnected = false;
            throw new Error("Realm bridge bot is not in the world");
        }
        this.connectTimer = system.runTimeout(() => {
            this.connectTimer = undefined;
            if (!this.namespaceConnected) {
                this.wantsConnected = false;
                this.emitLocal("connect_error", "bridge-connect-timeout");
            }
        }, CONNECT_TIMEOUT_TICKS);
    }

    disconnect(): void {
        if (this.wantsConnected || this.namespaceConnected) this.channel.send({ t: "close" });
        this.namespaceConnected = false;
        this.wantsConnected = false;
        this.clearTimer();
        if (this.channel.socket === this) this.channel.socket = undefined;
    }

    emit(event: string, data?: unknown): boolean {
        if (!this.isConnected) {
            console.warn(`[sculwave] Cannot send '${event}': bridge socket disconnected.`);
            return false;
        }
        return this.channel.send({ t: "emit", ev: event, d: data });
    }

    onSio(state: "connect" | "disconnect" | "error", reason?: string): void {
        if (state === "connect") {
            this.clearTimer();
            this.namespaceConnected = true;
            this.emitLocal("connect", undefined);
        } else if (state === "disconnect") {
            const was = this.namespaceConnected;
            this.namespaceConnected = false;
            this.wantsConnected = false;
            if (was) this.emitLocal("disconnect", reason ?? "bridge-disconnect");
        } else {
            this.clearTimer();
            this.namespaceConnected = false;
            this.wantsConnected = false;
            this.emitLocal("connect_error", reason ?? "bridge-error");
        }
    }

    /** The bridge or the link to it went away. */
    lost(reason: string): void {
        const was = this.namespaceConnected;
        const connecting = this.wantsConnected && !was;
        this.namespaceConnected = false;
        this.wantsConnected = false;
        this.clearTimer();
        if (was) this.emitLocal("disconnect", reason);
        else if (connecting) this.emitLocal("connect_error", reason);
    }

    deliver(event: string, data: unknown): void {
        this.emitLocal(event, data);
    }

    private clearTimer(): void {
        if (this.connectTimer !== undefined) {
            system.clearRun(this.connectTimer);
            this.connectTimer = undefined;
        }
    }
}

const channel = new RealmChannel();

class RealmHttp implements BackendHttp {
    postJson(_serverUrl: string, path: string, body: unknown): Promise<BackendHttpResponse> {
        return channel.postJson(path, body);
    }
}

export function createHttp(): BackendHttp {
    channel.start();
    return new RealmHttp();
}

export function createSocket(_serverUrl: string, namespace: string): BackendSocket {
    channel.start();
    return new RealmSocket(channel, namespace);
}

export function isTransportPlayer(name: string): boolean {
    return channel.isBridge(name);
}

export function handleTransportScriptEvent(event: ScriptEventCommandMessageAfterEvent): boolean {
    return channel.handleScriptEvent(event);
}

/** Admin command: /scriptevent sculwave:bridge <gamertag of the bridge bot> */
export function transportAdminCommand(id: string, message: string, sender: Player): boolean {
    if (id !== "sculwave:bridge") return false;
    if (!message) {
        sender.sendMessage(`§eBridge bot: §f${channel.bridgeName || "(not set)"}\n§cUsage: /scriptevent sculwave:bridge <gamertag>`);
        return true;
    }
    world.setDynamicProperty(BRIDGE_PROPERTY, message);
    channel.markDead("bridge-changed");
    channel.start();
    sender.sendMessage(`§a[Sculwave] Bridge bot set to ${message}.`);
    channel.sendHello();
    return true;
}

export function onTransportPlayerSpawn(player: Player): void {
    channel.start();
    if (!channel.isBridge(player.name)) return;
    // Hide the bot: spectator + invisible. Best effort, never fatal.
    system.run(() => {
        try {
            player.runCommand("gamemode spectator @s");
            player.runCommand("effect @s invisibility 1000000 0 true");
        } catch {
            // Commands can fail if the bot has not finished spawning.
        }
    });
    channel.sendHello();
}

export function onTransportPlayerLeave(name: string): void {
    if (channel.isBridge(name)) channel.markDead("bridge-left");
}

export function describeTransport(): string {
    const name = channel.bridgeName || "(not set)";
    return `realm bridge ${name}: ${channel.alive ? "online" : "offline"}`;
}
