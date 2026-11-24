import "../../src/common/metadata/reflect-shim";
import { describe, expect, test } from "bun:test";
import {
  type BunWsClient,
  type BunWsServer,
  ConnectedSocket,
  getGatewayMessageHandlers,
  getGatewayMethodParams,
  getGatewayServerProperties,
  MessageBody,
  parseWsFrame,
  serializeWsFrame,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from "../../src/ws/index";

describe("WebSocket Framing & Metadata Decorators", () => {
  test("serializes and parses JSON frames while stripping prototype pollution keys", () => {
    expect(serializeWsFrame("ping", { n: 1 }, "req-1")).toBe(
      '{"event":"ping","data":{"n":1},"id":"req-1"}',
    );
    expect(serializeWsFrame("hello")).toBe('{"event":"hello"}');

    const parsed = parseWsFrame(
      '{"event":"chat","id":42,"data":{"text":"hi","__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"ok":true}}}',
    );
    expect(parsed).toEqual({
      event: "chat",
      id: "42",
      data: { text: "hi", nested: { ok: true } },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Malformed or missing-event frames return null
    expect(parseWsFrame("{bad json")).toBeNull();
    expect(parseWsFrame("[]")).toBeNull();
    expect(parseWsFrame('{"data":1}')).toBeNull();
    expect(parseWsFrame('{"event":""}')).toBeNull();
  });

  test("preserves inheritance safety for @SubscribeMessage, @MessageBody, and @WebSocketServer", () => {
    @WebSocketGateway({ path: "/base" })
    class BaseGateway {
      @WebSocketServer()
      server!: BunWsServer;

      @SubscribeMessage("ping")
      ping(@MessageBody() data: string) {
        return data;
      }
    }

    @WebSocketGateway({ path: "/child" })
    class ChildGateway extends BaseGateway {
      @SubscribeMessage("pong")
      pong(
        @ConnectedSocket() client: BunWsClient,
        @MessageBody("msg") msg: string,
      ) {
        return { id: client.id, msg };
      }
    }

    const baseHandlers = getGatewayMessageHandlers(BaseGateway);
    const childHandlers = getGatewayMessageHandlers(ChildGateway);

    expect(baseHandlers.map((h) => h.event)).toEqual(["ping"]);
    expect(childHandlers.map((h) => h.event)).toEqual(["ping", "pong"]);

    expect(getGatewayServerProperties(BaseGateway)).toEqual(["server"]);
    expect(getGatewayServerProperties(ChildGateway)).toEqual(["server"]);

    const childParams = getGatewayMethodParams(ChildGateway, "pong");
    expect(childParams).toHaveLength(2);
    expect(childParams[0]).toMatchObject({ index: 0, source: "client" });
    expect(childParams[1]).toMatchObject({
      index: 1,
      source: "body",
      key: "msg",
      metatype: String,
    });
  });

  test("WsException preserves string and structured error payloads", () => {
    const strErr = new WsException("bad token");
    expect(strErr).toBeInstanceOf(Error);
    expect(strErr.message).toBe("bad token");
    expect(strErr.getError()).toBe("bad token");

    const objErr = new WsException({
      code: "RATE_LIMIT",
      message: "slow down",
    });
    expect(objErr.message).toBe("slow down");
    expect(objErr.getError()).toEqual({
      code: "RATE_LIMIT",
      message: "slow down",
    });
  });
});
