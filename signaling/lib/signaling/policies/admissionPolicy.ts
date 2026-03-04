/**
 * Default signaling admission policy implementations.
 */
import type { AdmissionPolicies } from "./types.js";

/**
 * Default identity admission policy used by signaling.
 *
 * Region validation is always enforced.
 *
 * For auth/token-based admission, extend `AdmissionPolicies` in
 * `signaling/policies/types.ts` with your auth hook and wire it in signaling
 * request dispatch before `validateIdentityRegion`.
 */
export const defaultAdmissionPolicy: AdmissionPolicies = {
  /**
   * Accepts websocket identity requests only when region is known by registry.
   *
   * @param params Region request and region existence checker.
   * @returns Admission decision mapped to websocket protocol errors by caller.
   */
  validateIdentityRegion: ({ region, hasRegion }) => {
    if (hasRegion(region)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      error: "invalidRegion",
      detail: `region ${region} doesn't exist`,
    };
  },
};
