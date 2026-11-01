import { HttpHeader, HttpRequest, HttpRequestMethod, http } from '@minecraft/server-net';
import { system } from '@minecraft/server';
import { SocketIOClient } from './SocketIOClient';

export interface BackendPlayerPayload {
    gamertag: string;
    x: number;
    y: number;
    z: number;
    dimension: string;
    groupId: string | null;
    isMuted: boolean;
    platform?: string;
    device?: string;
}

interface ActivateResponse {
    success: boolean;
    backendId?: string;
    instanceId?: string;
    heartbeatInterval?: number;
    message?: string;
}

interface RegisterSuccess {
    roomCode: string;
    token: string;
}

export class BackendConnection {
    private socket: SocketIOClient | undefined;
    private reconnectScheduled = false;
    private activationInProgress = false;
    private heartbeatIntervalMs = 1000;
    private shuttingDown = false;

    private roomCode = "";
    private authToken = "";
    private authenticated = false;

    constructor(
        private readonly serverUrl: string,
        private activationKey: string,
        private backendId: string,
        private instanceId: string,
        private readonly serverName: string,
        private readonly pluginVersion: string,
        private readonly minecraftVersion: string,
        private readonly onActivated: (state: {
            backendId: string;
            instanceId: string;
            heartbeatInterval: number;
        }) => void,
        private readonly onRoom: (roomCode: string) => void,
    ) { }

    get room(): string {
        return this.roomCode;
    }

    get token(): string {
        return this.authToken;
    }

    get isAuthenticated(): boolean {
        return this.authenticated;
    }

    get heartbeatInterval(): number {
        return this.heartbeatIntervalMs;
    }

    setActivationKey(value: string): void {
        this.activationKey = value.trim();
    }

    setIdentity(backendId: string, instanceId: string): void {
        this.backendId = backendId;
        this.instanceId = instanceId;
    }

    async activate(): Promise<boolean> {
        if (this.activationInProgress) return false;
        if (!this.activationKey) {
            console.warn("[sculwave] activation-key cannot be empty.");
            return false;
        }

        this.activationInProgress = true;

        try {
            const request = new HttpRequest(`${this.serverUrl}/api/backend/activate`);
            request.setMethod(HttpRequestMethod.Post);
            request.setHeaders([
                new HttpHeader("Content-Type", "application/json"),
            ]);

            const payload = {
                activationKey: this.activationKey,
                backendId: this.backendId || null,
                serverName: this.serverName,
                platform: "bedrock",
                pluginVersion: this.pluginVersion,
                minecraftVersion: this.minecraftVersion,

                // These must be populated with the values expected by your backend.
                entryPoint: "bedrock",
                entryPointPriority: 0,
            };





            request.setBody(JSON.stringify(payload));

            const response = await http.request(request);
            let data: ActivateResponse;

            try {
                data = JSON.parse(response.body) as ActivateResponse;
            } catch {
                console.warn(`[sculwave] Activation returned invalid JSON (HTTP ${response.status}).`);
                return false;
            }

            if (response.status !== 200 || !data.success || !data.backendId || !data.instanceId) {
                console.warn(
                    `[sculwave] Plugin activation failed. HTTP ${response.status}: ${data.message ?? response.body}`,
                );
                return false;
            }

            this.backendId = data.backendId;
            this.instanceId = data.instanceId;
            this.heartbeatIntervalMs = 1000;

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
        } catch (error) {
            console.warn(`[sculwave] Activation request failed: ${error}`);
            return false;
        } finally {
            this.activationInProgress = false;
        }
    }

    async connect(): Promise<void> {
        this.shuttingDown = false;

        if (!this.backendId || !this.instanceId) {
            console.warn("[sculwave] Cannot connect before activation.");
            return;
        }

        if (this.socket?.isConnected) return;

        this.socket?.disconnect();
        this.socket = new SocketIOClient(this.serverUrl, "/backend");
        this.bindSocketEvents(this.socket);

        try {
            await this.socket.connect();
        } catch {
            this.scheduleReconnect();
        }
    }

    disconnect(): void {
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

    sendHeartbeat(players: BackendPlayerPayload[], voiceEnabled = true): void {
        if (!this.authenticated || !this.socket?.isConnected) {
            console.warn("[EchoWave] Heartbeat skipped: socket not authenticated or disconnected.");
            return;
        };

        const sent = this.socket.emit("backend-heartbeat", {
            players,
            timestamp: Date.now(),
            voiceEnabled,
        });


        if (sent) {
            console.info(
                `[EchoWave] Heartbeat sent | Players: ${players.length} | Voice: ${voiceEnabled}`
            );
        } else {
            console.warn("[EchoWave] Heartbeat transmission failed.");
        }


    }

    private bindSocketEvents(socket: SocketIOClient): void {
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
            const result = data as RegisterSuccess;
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

    private scheduleReconnect(): void {
        if (this.shuttingDown || this.reconnectScheduled) return;

        this.reconnectScheduled = true;
        system.runTimeout(() => {
            this.reconnectScheduled = false;
            if (this.shuttingDown) return;

            void this.connect();
        }, 100);
    }

}
