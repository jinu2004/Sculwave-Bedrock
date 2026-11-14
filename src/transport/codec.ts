/**
 * Sculwave Realm channel codec.
 *
 * Shared, dependency-free. The addon copy (addon/src/transport/codec.ts) and the bridge
 * copy (realm-bridge/src/codec.ts) MUST stay identical: run `npm run sync-codec` in
 * realm-bridge after editing this file.
 *
 * Wire format (everything is pure ASCII, non-ASCII is \uXXXX-escaped):
 *   addon  -> bridge : private chat line   "SW1|<sid>|<id>|<part>|<parts>|<json chunk>"
 *   bridge -> addon  : /scriptevent sculwave:rx <sid>|<id>|<part>|<parts>|<json chunk>
 */

export const PROTOCOL_VERSION = 1;
export const TX_MARK = "SW1";
export const RX_EVENT_ID = "sculwave:rx";
export const SEP = "|";

/** Messages sent by the addon. */
export type AddonMsg =
    | { t: "hello"; v: number }
    | { t: "ping" }
    | { t: "http"; id: number; path: string; body: string }
    | { t: "open"; ns: string }
    | { t: "emit"; ev: string; d?: unknown }
    | { t: "close" };

/** Messages sent by the bridge. */
export type BridgeMsg =
    | { t: "ready"; v: number; run: string }
    | { t: "pong"; run: string; sock: boolean }
    | { t: "http-res"; id: number; status: number; body: string }
    | { t: "sio"; s: "connect" | "disconnect" | "error"; r?: string }
    | { t: "ev"; ev: string; d?: unknown }
    | { t: "evs"; l: Array<[string, unknown]> };

export interface ParsedFrame {
    sid: string;
    id: string;
    part: number;
    parts: number;
    data: string;
}

/** JSON.stringify that only emits ASCII and never contains '@' (command selectors). */
export function toWire(value: unknown): string {
    return JSON.stringify(value)
        .replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
        .replace(/@/g, "\\u0040");
}

export function randomId(length = 12): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

/** Splits one JSON string into frame bodies ("sid|id|part|parts|data") of at most maxLen chars. */
export function encodeFrames(sid: string, id: string, json: string, maxLen: number): string[] {
    const overhead = sid.length + id.length + 16;
    const size = Math.max(32, maxLen - overhead);
    const parts = Math.max(1, Math.ceil(json.length / size));
    const out: string[] = [];
    for (let i = 0; i < parts; i++) {
        out.push([sid, id, i, parts, json.slice(i * size, (i + 1) * size)].join(SEP));
    }
    return out;
}

/** Parses a frame body. Returns undefined when malformed. */
export function parseFrame(body: string): ParsedFrame | undefined {
    const idx: number[] = [];
    let from = 0;
    for (let i = 0; i < 4; i++) {
        const at = body.indexOf(SEP, from);
        if (at === -1) return undefined;
        idx.push(at);
        from = at + 1;
    }
    const [a, b, c, d] = idx as [number, number, number, number];
    const sid = body.slice(0, a);
    const id = body.slice(a + 1, b);
    const partNum = Number(body.slice(b + 1, c));
    const partsNum = Number(body.slice(c + 1, d));
    if (!sid || !id) return undefined;
    if (!Number.isInteger(partNum) || !Number.isInteger(partsNum)) return undefined;
    if (partsNum < 1 || partsNum > 64 || partNum < 0 || partNum >= partsNum) return undefined;
    return { sid, id, part: partNum, parts: partsNum, data: body.slice(d + 1) };
}

/** Reassembles multi-part messages. */
export class Reassembler {
    private pending = new Map<string, { parts: Array<string | undefined>; got: number; at: number }>();

    constructor(private readonly ttlMs = 10_000, private readonly maxPending = 64) { }

    push(frame: ParsedFrame, now: number): string | undefined {
        if (frame.parts === 1) return frame.data;

        const key = frame.sid + SEP + frame.id;
        let entry = this.pending.get(key);
        if (!entry) {
            if (this.pending.size >= this.maxPending) this.sweep(now, true);
            entry = { parts: new Array<string | undefined>(frame.parts).fill(undefined), got: 0, at: now };
            this.pending.set(key, entry);
        }
        if (entry.parts.length !== frame.parts) return undefined;
        if (entry.parts[frame.part] === undefined) {
            entry.parts[frame.part] = frame.data;
            entry.got++;
        }
        if (entry.got < entry.parts.length) return undefined;

        this.pending.delete(key);
        return entry.parts.join("");
    }

    sweep(now: number, dropOldest = false): void {
        for (const [key, entry] of this.pending) {
            if (now - entry.at > this.ttlMs) this.pending.delete(key);
        }
        if (dropOldest && this.pending.size >= this.maxPending) {
            const first = this.pending.keys().next();
            if (!first.done) this.pending.delete(first.value);
        }
    }
}
