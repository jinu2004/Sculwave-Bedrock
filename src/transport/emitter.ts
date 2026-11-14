import type { SocketHandler } from './types';

export class Emitter {
    private handlers = new Map<string, Set<SocketHandler>>();

    on(event: string, handler: SocketHandler): void {
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(handler);
    }

    off(event: string, handler?: SocketHandler): void {
        if (!handler) {
            this.handlers.delete(event);
            return;
        }
        const set = this.handlers.get(event);
        set?.delete(handler);
        if (set?.size === 0) this.handlers.delete(event);
    }

    protected emitLocal(event: string, data: unknown): void {
        const set = this.handlers.get(event);
        if (!set) return;
        for (const handler of set) {
            try {
                handler(data);
            } catch (error) {
                console.warn(`[sculwave] handler '${event}' failed: ${error}`);
            }
        }
    }
}
