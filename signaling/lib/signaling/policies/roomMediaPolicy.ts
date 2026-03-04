/**
 * Default room media policy implementations.
 */
import type { RoomMediaPolicies } from "./types.js";

/**
 * Default room media policy.
 *
 * Allows both request-side fanout and send-side media upload paths.
 */
export const defaultRoomMediaPolicy: RoomMediaPolicies = {
  allowRoomAudioRequest: () => true,
  allowRoomVideoRequest: () => true,
  allowRoomAudioUpload: () => true,
  allowRoomVideoUpload: () => true,
};
