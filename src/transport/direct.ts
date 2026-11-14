/**
 * Direct transport (Bedrock Dedicated Server): HTTP + WebSocket through @minecraft/server-net.
 * This is the original behaviour. It must NOT be imported by the Realm build.
 */
import { HttpHeader, HttpRequest, HttpRequestMethod, http } from '@minecraft/server-net';
import type { Player, ScriptEventCommandMessageAfterEvent } from '@minecraft/server';
import { SocketIOClient } from '../backend/SocketIOClient';
import type { BackendHttp, BackendHttpResponse, BackendSocket } from './types';

export const TRANSPORT_KIND: "direct" | "realm" = "direct";

class DirectHttp implements BackendHttp {
    async postJson(serverUrl: string, path: string, body: unknown): Promise<BackendHttpResponse> {
        const request = new HttpRequest(`${serverUrl}${path}`);
        request.setMethod(HttpRequestMethod.Post);
        request.setHeaders([new HttpHeader("Content-Type", "application/json")]);
        request.setBody(JSON.stringify(body));
        const response = await http.request(request);
        return { status: response.status, body: response.body };
    }
}

export function createHttp(): BackendHttp {
    return new DirectHttp();
}

export function createSocket(serverUrl: string, namespace: string): BackendSocket {
    return new SocketIOClient(serverUrl, namespace);
}

export function isTransportPlayer(_name: string): boolean {
    return false;
}

export function handleTransportScriptEvent(_event: ScriptEventCommandMessageAfterEvent): boolean {
    return false;
}

export function transportAdminCommand(_id: string, _message: string, _sender: Player): boolean {
    return false;
}

export function onTransportPlayerSpawn(_player: Player): void { }
export function onTransportPlayerLeave(_name: string): void { }

export function describeTransport(): string {
    return "direct (server-net)";
}
