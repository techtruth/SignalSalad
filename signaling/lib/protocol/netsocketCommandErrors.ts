/**
 * Semantic error kinds for recoverable netsocket callback handling.
 *
 * These are used to classify out-of-order callbacks and transient delivery
 * failures without relying on brittle string matching.
 */
export type RecoverableNetsocketErrorKind =
  | "stateDrift"
  | "deliveryUnavailable"
  | "relayEndpointUnavailable";

/**
 * Error type for recoverable media-server callback failures.
 *
 * Signaling catches this and records a warning diagnostic instead of treating
 * it as a hard control-plane fault.
 */
export class RecoverableNetsocketCommandError extends Error {
  readonly kind: RecoverableNetsocketErrorKind;

  constructor(
    kind: RecoverableNetsocketErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "RecoverableNetsocketCommandError";
    this.kind = kind;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }

  static wrap(params: {
    kind: RecoverableNetsocketErrorKind;
    message: string;
    cause: unknown;
  }) {
    const { kind, message, cause } = params;
    if (cause instanceof RecoverableNetsocketCommandError) {
      return cause;
    }
    return new RecoverableNetsocketCommandError(kind, message, cause);
  }
}
