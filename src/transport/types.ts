export type SocketHandler = (data: unknown) => void;

/** What BackendConnection needs from a Socket.IO-like connection (/backend namespace). */
export interface BackendSocket {
    readonly isConnected: boolean;
    on(event: string, handler: SocketHandler): void;
    off(event: string, handler?: SocketHandler): void;
    connect(): Promise<void>;
    disconnect(): void;
    emit(event: string, data?: unknown): boolean;
}

export interface BackendHttpResponse {
    status: number;
    body: string;
}

/** What BackendConnection needs to call the activation endpoint. */
export interface BackendHttp {
    postJson(serverUrl: string, path: string, body: unknown): Promise<BackendHttpResponse>;
}
