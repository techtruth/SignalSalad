import type { AddressInfo } from "net";

/**
 * Normalizes Node server address shapes for logs.
 *
 * - `AddressInfo` => `host:port`
 * - unix socket string => that path/string
 * - missing/null => `unknown`
 */
export const formatServerAddress = (
  address: AddressInfo | string | null | undefined,
) => {
  if (typeof address === "string") {
    return address;
  }
  if (!address) {
    return "unknown";
  }
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return `${host}:${address.port}`;
};
