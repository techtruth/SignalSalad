declare module "length-prefixed-stream" {
  import type { Transform } from "stream";
  export function encode(): Transform;
  export function decode(): Transform;
}
