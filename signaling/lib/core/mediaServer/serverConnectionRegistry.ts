import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { MediaServerMode } from "./types.js";

/**
 * Stable media-server identity bound to one active netsocket connection.
 */
export type MediaServerRegistration = {
  serverId: Guid;
  mode: MediaServerMode;
};

/**
 * Connection registry port consumed by media-server lifecycle orchestration.
 *
 * This isolates socket-index and identity-map mutations behind one cohesive API.
 */
export type MediaServerConnectionRegistryPort<ConnectionRef extends object> = {
  getServerConnection(
    serverId: Guid,
    mode: MediaServerMode,
  ): ConnectionRef | undefined;
  setServerConnection(
    serverId: Guid,
    mode: MediaServerMode,
    connection: ConnectionRef,
  ): void;
  removeServerConnection(
    serverId: Guid,
    mode: MediaServerMode,
  ): ConnectionRef | undefined;
  getIdentity(connection: ConnectionRef): MediaServerRegistration | undefined;
  setIdentity(
    connection: ConnectionRef,
    identity: MediaServerRegistration,
  ): void;
  deleteIdentity(connection: ConnectionRef): void;
  resolveRegisteredServerIp(
    serverId: Guid,
    mode: MediaServerMode,
  ): string | undefined;
};

/**
 * Constructor dependencies for the in-memory media-server connection registry.
 *
 * `transport` exposes mode-indexed server maps, `identities` tracks socket->identity
 * bindings, and `resolveConnectionAddress` normalizes socket addressing for relay setup.
 */
export type MediaServerConnectionRegistryContext<ConnectionRef extends object> =
  {
    transport: {
      getServersByMode(mode: MediaServerMode): Map<Guid, ConnectionRef>;
    };
    identities: WeakMap<ConnectionRef, MediaServerRegistration>;
    resolveConnectionAddress: (connection: ConnectionRef) => string | undefined;
  };

/**
 * Default in-memory implementation backed by mode-indexed socket maps and a
 * connection identity WeakMap.
 */
export class MediaServerConnectionRegistry<
  ConnectionRef extends object,
> implements MediaServerConnectionRegistryPort<ConnectionRef> {
  private readonly context: MediaServerConnectionRegistryContext<ConnectionRef>;

  constructor(context: MediaServerConnectionRegistryContext<ConnectionRef>) {
    this.context = context;
  }

  getServerConnection(serverId: Guid, mode: MediaServerMode) {
    return this.context.transport.getServersByMode(mode).get(serverId);
  }

  setServerConnection(
    serverId: Guid,
    mode: MediaServerMode,
    connection: ConnectionRef,
  ) {
    this.context.transport.getServersByMode(mode).set(serverId, connection);
  }

  removeServerConnection(serverId: Guid, mode: MediaServerMode) {
    const servers = this.context.transport.getServersByMode(mode);
    const connection = servers.get(serverId);
    if (connection) {
      this.context.identities.delete(connection);
    }
    servers.delete(serverId);
    return connection;
  }

  getIdentity(connection: ConnectionRef) {
    return this.context.identities.get(connection);
  }

  setIdentity(connection: ConnectionRef, identity: MediaServerRegistration) {
    this.context.identities.set(connection, identity);
  }

  deleteIdentity(connection: ConnectionRef) {
    this.context.identities.delete(connection);
  }

  resolveRegisteredServerIp(serverId: Guid, mode: MediaServerMode) {
    const connection = this.getServerConnection(serverId, mode);
    if (!connection) {
      return undefined;
    }
    return this.context.resolveConnectionAddress(connection);
  }
}
