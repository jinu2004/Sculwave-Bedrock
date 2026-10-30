import { HttpHeader, HttpRequest, http } from '@minecraft/server-net';
import { system } from '@minecraft/server';
import { SocketIOClient } from './SocketIOClient';
export class BackendConnection {
    constructor(serverUrl, activationKey, backendId, instanceId, serverName, pluginVersion, minecraftVersion, onActivated, onRoom) {
        this.serverUrl = serverUrl;
        this.activationKey = activationKey;
        this.backendId = backendId;
        this.instanceId = instanceId;
        this.serverName = serverName;
        this.pluginVersion = pluginVersion;
        this.minecraftVersion = minecraftVersion;
        this.onActivated = onActivated;
        this.onRoom = onRoom;
        this.reconnectScheduled = false;
        this.activationInProgress = false;
        this.heartbeatIntervalMs = 15000;
        this.shuttingDown = false;
        this.roomCode = "";
        this.authToken = "";
        this.authenticated = false;
    }
    get room() {
        return this.roomCode;
    }
    get token() {
        return this.authToken;
    }
    get isAuthenticated() {
        return this.authenticated;
    }
    get heartbeatInterval() {
        return this.heartbeatIntervalMs;
    }
    setActivationKey(value) {
        this.activationKey = value.trim();
    }
    setIdentity(backendId, instanceId) {
        this.backendId = backendId;
        this.instanceId = instanceId;
    }
    async activate() {
        if (this.activationInProgress)
            return false;
        if (!this.activationKey) {
            console.warn("[sculwave] activation-key cannot be empty.");
            return false;
        }
        this.activationInProgress = true;
        try {
            const request = new HttpRequest(`${this.serverUrl}/api/backend/activate`);
            request.method = 'Post';
            request.setHeaders([
                new HttpHeader("Content-Type", "application/json"),
            ]);
            request.setBody(JSON.stringify({
                activationKey: this.activationKey,
                backendId: this.backendId || null,
                serverName: this.serverName,
                platform: "bedrock",
                pluginVersion: this.pluginVersion,
                minecraftVersion: this.minecraftVersion,
            }));
            const response = await http.request(request);
            let data;
            try {
                data = JSON.parse(response.body);
            }
            catch {
                console.warn(`[sculwave] Activation returned invalid JSON (HTTP ${response.status}).`);
                return false;
            }
            if (response.status !== 200 || !data.success || !data.backendId || !data.instanceId) {
                console.warn(`[sculwave] Plugin activation failed. HTTP ${response.status}: ${data.message ?? response.body}`);
                return false;
            }
            this.backendId = data.backendId;
            this.instanceId = data.instanceId;
            this.heartbeatIntervalMs = Math.max(1000, data.heartbeatInterval ?? 15000);
            this.onActivated({
                backendId: this.backendId,
                instanceId: this.instanceId,
                heartbeatInterval: this.heartbeatIntervalMs,
            });
            console.info("====================================");
            console.info("[sculwave] Bedrock activated successfully!");
            console.info(`Backend ID: ${this.backendId}`);
            console.info(`Instance ID: ${this.instanceId}`);
            console.info(`Heartbeat: ${this.heartbeatIntervalMs}ms`);
            console.info("====================================");
            return true;
        }
        catch (error) {
            console.warn(`[sculwave] Activation request failed: ${error}`);
            return false;
        }
        finally {
            this.activationInProgress = false;
        }
    }
    async connect() {
        this.shuttingDown = false;
        if (!this.backendId || !this.instanceId) {
            console.warn("[sculwave] Cannot connect before activation.");
            return;
        }
        if (this.socket?.isConnected)
            return;
        this.socket?.disconnect();
        this.socket = new SocketIOClient(this.serverUrl, "/backend");
        this.bindSocketEvents(this.socket);
        try {
            await this.socket.connect();
        }
        catch {
            this.scheduleReconnect();
        }
    }
    disconnect() {
        this.shuttingDown = true;
        if (this.authenticated && this.socket?.isConnected) {
            // Match the production Paper plugin: explicitly tell the backend
            // to destroy the room before closing the Socket.IO connection.
            this.socket.emit("backend-shutdown");
        }
        this.authenticated = false;
        this.socket?.disconnect();
        this.socket = undefined;
    }
    sendHeartbeat(players, voiceEnabled = true) {
        if (!this.authenticated || !this.socket?.isConnected)
            return;
        this.socket.emit("backend-heartbeat", {
            players,
            timestamp: Date.now(),
            voiceEnabled,
        });
    }
    bindSocketEvents(socket) {
        socket.on("connect", () => {
            console.info("[sculwave] Socket.IO connected to /backend.");
            this.authenticated = false;
            // Match the production Paper plugin: every new Socket.IO connection
            // begins by registering the backend identity.
            socket.emit("backend-register", {
                backendId: this.backendId,
                instanceId: this.instanceId,
            });
        });
        socket.on("backend-register-success", (data) => {
            const result = data;
            if (!result?.roomCode || !result?.token) {
                console.warn("[sculwave] Invalid backend-register-success payload.");
                return;
            }
            this.roomCode = result.roomCode;
            this.authToken = result.token;
            this.onRoom(this.roomCode);
            console.info(`[sculwave] Voice room created: ${this.roomCode}`);
            socket.emit("backend-auth", {
                backendId: this.backendId,
                instanceId: this.instanceId,
                token: this.authToken,
            });
        });
        socket.on("backend-register-failed", (reason) => {
            console.warn(`[sculwave] Backend registration failed: ${String(reason)}`);
            this.authenticated = false;
            socket.disconnect();
            this.scheduleReconnect();
        });
        socket.on("backend-auth-success", () => {
            this.authenticated = true;
            console.info("[sculwave] Backend Socket.IO authenticated.");
        });
        socket.on("backend-auth-failed", (reason) => {
            console.warn(`[sculwave] Backend authentication failed: ${String(reason)}`);
            this.authenticated = false;
            this.roomCode = "";
            this.authToken = "";
            this.onRoom("");
            socket.disconnect();
            this.scheduleReconnect();
        });
        socket.on("disconnect", (reason) => {
            this.authenticated = false;
            console.warn(`[sculwave] Socket.IO disconnected: ${String(reason)}`);
            if (!this.shuttingDown) {
                this.scheduleReconnect();
            }
        });
        socket.on("close", () => {
            if (!this.shuttingDown) {
                this.scheduleReconnect();
            }
        });
        socket.on("connect_error", (error) => {
            this.authenticated = false;
            console.warn(`[sculwave] Socket.IO connection error: ${String(error)}`);
            this.scheduleReconnect();
        });
    }
    scheduleReconnect() {
        if (this.shuttingDown || this.reconnectScheduled)
            return;
        this.reconnectScheduled = true;
        system.runTimeout(() => {
            this.reconnectScheduled = false;
            if (this.shuttingDown)
                return;
            void this.connect();
        }, 100);
    }
}
//# sourceMappingURL=BackendConnection.js.map