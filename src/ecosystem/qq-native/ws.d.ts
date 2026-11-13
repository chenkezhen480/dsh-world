/**
 * `ws` 的最小类型声明。
 *
 * 覆盖已安装 ws 的 SDK 客户端和本地桥所使用的接口。
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { EventEmitter } from 'node:events';
  import type { AddressInfo } from 'node:net';

  export const OPEN: number;

  export class WebSocket extends EventEmitter {
    constructor(address: string, protocolsOrOptions?: string | string[] | Record<string, unknown>, options?: Record<string, unknown>);
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'close' | 'error', listener: (error?: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { host?: string; port: number; path?: string });
    address(): AddressInfo | string | null;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'listening', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: 'listening', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    close(callback?: () => void): void;
  }

  export default WebSocket;
}
