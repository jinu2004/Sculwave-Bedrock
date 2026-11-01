import * as serverNet from '@minecraft/server-net';
/**
 * Minimal Socket.IO v4 client for the EchoWave /backend namespace.
 *
 * The Bedrock server-net API exposes a raw WebSocket, while the production
 * EchoWave backend speaks Socket.IO over Engine.IO v4. This class implements
 * only the protocol pieces the backend connector needs: namespace connect,
 * events, ping/pong, and disconnect.
 */
export class SocketIOClient {
    constructor(serverUrl, namespace = "/backend") {
        this.serverUrl = serverUrl;
        this.namespace = namespace;
        this.handlers = new Map();
        this.intentionallyClosed = false;
        this.namespaceConnected = false;
        this.connecting = false;
    }
    get isConnected() {
        return this.namespaceConnected && this.client?.isOpen === true;
    }
    on(event, handler) {
        let handlers = this.handlers.get(event);
        if (!handlers) {
            handlers = new Set();
            this.handlers.set(event, handlers);
        }
        handlers.add(handler);
    }
    off(event, handler) {
        if (!handler) {
            this.handlers.delete(event);
            return;
        }
        const handlers = this.handlers.get(event);
        handlers?.delete(handler);
        if (handlers?.size === 0) {
            this.handlers.delete(event);
        }
    }
    async connect() {
        if (this.isConnected || this.connecting)
            return;
        this.intentionallyClosed = false;
        this.connecting = true;
        try {
            const uri = this.buildWebSocketUri();
            console.info(`[Echowave] Socket.IO connecting: ${uri}`);
            const websocketApi = serverNet.websocket;
            const client = await websocketApi.connect(uri);
            this.client = client;
            client.afterEvents.message.subscribe((event) => {
                this.handlePacket(event.message);
            });
            client.afterEvents.close.subscribe(() => {
                const wasConnected = this.namespaceConnected;
                this.namespaceConnected = false;
                this.connecting = false;
                if (wasConnected) {
                    this.emitLocal("disconnect", "websocket-close");
                }
                if (!this.intentionallyClosed) {
                    this.emitLocal("close", undefined);
                }
            });
        }
        catch (error) {
            this.connecting = false;
            this.namespaceConnected = false;
            this.emitLocal("connect_error", error);
            throw error;
        }
    }
    disconnect() {
        this.intentionallyClosed = true;
        this.namespaceConnected = false;
        this.connecting = false;
        try {
            if (this.client?.isOpen) {
                this.client.send("41/backend,");
                this.client.close();
            }
        }
        catch {
            // The WebSocket may already be closed. Nothing else is required.
        }
        this.client = undefined;
    }
    emit(event, data) {
        if (!this.isConnected || !this.client) {
            console.warn(`[EchoWave] Cannot send '${event}': Socket.IO disconnected.`);
            return false;
        }
        const payload = data === undefined ? [event] : [event, data];
        try {
            const packet = `42${this.namespace},${JSON.stringify(payload)}`;
            this.client.send(packet);
            console.info(`[EchoWave] Socket.IO event transmitted: ${event}`);
            return true;
        }
        catch (error) {
            console.warn(`[EchoWave] Socket.IO send failed (${event}): ${error}`);
            return false;
        }
    }
    buildWebSocketUri() {
        const serverUrl = this.serverUrl.trim();
        if (serverUrl.startsWith("https://")) {
            const host = serverUrl.slice("https://".length).split("/")[0];
            return `wss://${host}/socket.io/?EIO=4&transport=websocket`;
        }
        if (serverUrl.startsWith("http://")) {
            const host = serverUrl.slice("http://".length).split("/")[0];
            return `ws://${host}/socket.io/?EIO=4&transport=websocket`;
        }
        throw new Error("[EchoWave] serverUrl must start with http:// or https://");
    }
    handlePacket(packet) {
        if (!packet)
            return;
        const engineType = packet[0];
        switch (engineType) {
            case "0":
                // Engine.IO OPEN. Join the Socket.IO namespace.
                this.sendRaw(`40${this.namespace},`);
                return;
            case "1":
                this.namespaceConnected = false;
                this.client = undefined;
                this.emitLocal("disconnect", "engine-close");
                return;
            case "2":
                // Engine.IO PING -> Engine.IO PONG.
                this.sendRaw("3");
                return;
            case "3":
                return;
            case "4":
                this.handleSocketIOPacket(packet.substring(1));
                return;
            default:
                console.warn(`[Echowave] Unknown Engine.IO packet: ${packet}`);
        }
    }
    handleSocketIOPacket(packet) {
        if (!packet)
            return;
        const type = packet[0];
        let remainder = packet.substring(1);
        let namespace = "/";
        if (remainder.startsWith("/")) {
            const comma = remainder.indexOf(",");
            if (comma === -1) {
                namespace = remainder;
                remainder = "";
            }
            else {
                namespace = remainder.substring(0, comma);
                remainder = remainder.substring(comma + 1);
            }
        }
        if (namespace !== this.namespace)
            return;
        switch (type) {
            case "0":
                this.namespaceConnected = true;
                this.connecting = false;
                this.emitLocal("connect", undefined);
                return;
            case "1":
                this.namespaceConnected = false;
                this.emitLocal("disconnect", "namespace-close");
                return;
            case "2": {
                let eventPayload;
                try {
                    eventPayload = JSON.parse(remainder);
                }
                catch (error) {
                    console.warn(`[Echowave] Invalid Socket.IO event payload: ${error}`);
                    return;
                }
                if (!Array.isArray(eventPayload) || typeof eventPayload[0] !== "string") {
                    console.warn(`[Echowave] Invalid Socket.IO event: ${remainder}`);
                    return;
                }
                const eventName = eventPayload[0];
                const data = eventPayload.length > 1 ? eventPayload[1] : undefined;
                console.info(`[EchoWave] Socket.IO event received: ${eventName}`);
                this.emitLocal(eventName, data);
                return;
            }
            case "3":
                // No acknowledgements are currently used by the backend.
                return;
            case "4":
                this.emitLocal("connect_error", remainder);
                return;
            default:
                console.warn(`[Echowave] Unsupported Socket.IO packet type: ${type}`);
        }
    }
    sendRaw(packet) {
        try {
            if (this.client?.isOpen) {
                this.client.send(packet);
            }
        }
        catch (error) {
            console.warn(`[Echowave] Socket.IO raw send failed: ${error}`);
        }
    }
    emitLocal(event, data) {
        const handlers = this.handlers.get(event);
        if (!handlers)
            return;
        for (const handler of handlers) {
            try {
                handler(data);
            }
            catch (error) {
                console.warn(`[Echowave] Socket.IO event handler '${event}' failed: ${error}`);
            }
        }
    }
}
//# sourceMappingURL=SocketIOClient.js.map