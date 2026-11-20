import { isDangerousKey, sanitizeObject, type BunServerLike } from "@bunest/http";
import type {
  BunServerWebSocketLike,
  BunWsClient,
  BunWsServer,
  WsMessageFrame,
  WsRoomEmitter,
} from "../interfaces/ws.interface";

export interface BunWsSocketData {
  readonly gatewayId: string;
  readonly clientId: string;
  readonly request: Request;
  readonly path: string;
  readonly namespace: string;
  readonly handshakeData: Record<string, unknown>;
  client?: BunWsClientImpl;
}

export function buildGatewayAllTopic(gatewayId: string): string {
  return `bunest:ws:${gatewayId}:all`;
}

export function buildGatewayRoomTopic(gatewayId: string, room: string): string {
  return `bunest:ws:${gatewayId}:room:${room}`;
}

export function serializeWsFrame(
  event: string,
  data?: unknown,
  id?: string,
): string {
  const frame: Record<string, unknown> = { event };
  if (data !== undefined) {
    frame.data = data;
  }
  if (id !== undefined) {
    frame.id = id;
  }
  return JSON.stringify(frame);
}

/**
 * Parses an incoming text WebSocket frame expecting JSON `{ event, data?, id? }`,
 * sanitizing parsed payloads against prototype pollution.
 */
export function parseWsFrame(rawText: string): WsMessageFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.event !== "string" || record.event.length === 0) {
    return null;
  }

  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.id === "number"
        ? String(record.id)
        : undefined;

  const data =
    "data" in record ? sanitizeObject(record.data) : undefined;

  return {
    event: record.event,
    data,
    id,
  };
}

/**
 * Concrete `BunWsClient` backed by Bun's native `ServerWebSocket` and native pub/sub.
 */
export class BunWsClientImpl<
  TData extends Record<string, unknown> = Record<string, unknown>,
> implements BunWsClient<TData>
{
  public readonly id: string;
  public readonly data: TData;
  public readonly request: Request;
  public readonly raw: BunServerWebSocketLike<BunWsSocketData>;
  private readonly gatewayId: string;
  private readonly joinedRooms = new Set<string>();

  constructor(
    ws: BunServerWebSocketLike<BunWsSocketData>,
    socketData: BunWsSocketData,
  ) {
    this.raw = ws;
    this.id = socketData.clientId;
    this.data = socketData.handshakeData as TData;
    this.request = socketData.request;
    this.gatewayId = socketData.gatewayId;
  }

  get rooms(): ReadonlySet<string> {
    return this.joinedRooms;
  }

  send<T = unknown>(event: string, data?: T, id?: string): void {
    this.emit(event, data, id);
  }

  emit<T = unknown>(event: string, data?: T, id?: string): void {
    const payload = serializeWsFrame(event, data, id);
    this.raw.send(payload);
  }

  sendRaw(data: string | ArrayBuffer | ArrayBufferView): void {
    this.raw.send(data);
  }

  join(room: string): void {
    if (!room || isDangerousKey(room)) {
      return;
    }
    const topic = buildGatewayRoomTopic(this.gatewayId, room);
    this.raw.subscribe(topic);
    this.joinedRooms.add(room);
  }

  leave(room: string): void {
    if (!room) {
      return;
    }
    const topic = buildGatewayRoomTopic(this.gatewayId, room);
    this.raw.unsubscribe(topic);
    this.joinedRooms.delete(room);
  }

  /**
   * Emits to all OTHER clients in `room` (excluding this sender), using Bun's
   * native `ws.publish(topic, payload)` semantics.
   */
  to(room: string): WsRoomEmitter {
    const topic = buildGatewayRoomTopic(this.gatewayId, room);
    const publishFrame = <T = unknown>(event: string, data?: T) => {
      const payload = serializeWsFrame(event, data);
      this.raw.publish(topic, payload);
    };
    return {
      emit: publishFrame,
      send: publishFrame,
    };
  }

  /**
   * Broadcasts to all OTHER clients connected to this gateway (excluding sender).
   */
  broadcast<T = unknown>(event: string, data?: T): void {
    const payload = serializeWsFrame(event, data);
    this.raw.publish(buildGatewayAllTopic(this.gatewayId), payload);
  }

  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }

  /** @internal */
  clearTrackedRooms(): void {
    this.joinedRooms.clear();
  }
}

/**
 * Concrete `BunWsServer` backed by Bun's native `server.publish()` (which delivers
 * to ALL subscribers INCLUDING sender) and `server.subscriberCount()`.
 */
export class BunWsServerImpl implements BunWsServer {
  public readonly path: string;
  public readonly namespace: string;
  private readonly gatewayId: string;
  private readonly clientMap = new Map<string, BunWsClientImpl>();
  private readonly getBunServer: () => BunServerLike | undefined;

  constructor(
    gatewayId: string,
    path: string,
    namespace: string,
    getBunServer: () => BunServerLike | undefined,
  ) {
    this.gatewayId = gatewayId;
    this.path = path;
    this.namespace = namespace;
    this.getBunServer = getBunServer;
  }

  get clients(): ReadonlyMap<string, BunWsClient> {
    return this.clientMap;
  }

  /** @internal */
  addClient(client: BunWsClientImpl): void {
    this.clientMap.set(client.id, client);
  }

  /** @internal */
  removeClient(clientId: string): void {
    this.clientMap.delete(clientId);
  }

  /**
   * Emits to ALL clients connected to this gateway (including sender) via `server.publish()`.
   */
  emit<T = unknown>(event: string, data?: T): void {
    const payload = serializeWsFrame(event, data);
    const bunServer = this.getBunServer();
    if (bunServer?.publish) {
      bunServer.publish(buildGatewayAllTopic(this.gatewayId), payload);
      return;
    }
    for (const client of this.clientMap.values()) {
      client.sendRaw(payload);
    }
  }

  /**
   * Emits to ALL subscribers in `room` (including sender) via `server.publish()`.
   */
  to(room: string): WsRoomEmitter {
    const topic = buildGatewayRoomTopic(this.gatewayId, room);
    const publishFrame = <T = unknown>(event: string, data?: T) => {
      const payload = serializeWsFrame(event, data);
      const bunServer = this.getBunServer();
      if (bunServer?.publish) {
        bunServer.publish(topic, payload);
        return;
      }
      for (const client of this.clientMap.values()) {
        if (client.rooms.has(room)) {
          client.sendRaw(payload);
        }
      }
    };
    return {
      emit: publishFrame,
      send: publishFrame,
    };
  }

  in(room: string): WsRoomEmitter {
    return this.to(room);
  }

  subscriberCount(room: string): number {
    const topic = buildGatewayRoomTopic(this.gatewayId, room);
    const bunServer = this.getBunServer();
    if (bunServer?.subscriberCount) {
      return bunServer.subscriberCount(topic);
    }
    let count = 0;
    for (const client of this.clientMap.values()) {
      if (client.rooms.has(room)) {
        count++;
      }
    }
    return count;
  }

  disconnectAll(code = 1001, reason = "Server shutting down"): void {
    const snapshot = [...this.clientMap.values()];
    for (let i = 0; i < snapshot.length; i++) {
      const client = snapshot[i];
      if (!client) continue;
      try {
        client.close(code, reason);
      } catch {
        // Ignore already-closed sockets
      }
    }
    this.clientMap.clear();
  }
}
