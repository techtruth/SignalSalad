/**
 * @file Controller UI state model + reducer.
 * Centralizes state updates so UI can be driven from a single source.
 * @internal
 */

/**
 * UI-facing state used by controller panels.
 * @internal
 */
export type MediasoupSessionControllerState = {
  peerId?: string;
  room?: string;
  joined: boolean;
  signalingConnected: boolean;
  signalingUrl?: string;
  hasIdentity: boolean;
};

/**
 * Reducer actions emitted by adapter events.
 * @internal
 */
export type MediasoupSessionControllerStateAction =
  | { type: "IDENTITY"; peerId: string }
  | { type: "ROOM_ATTACHED"; room: string }
  | { type: "ROOM_DETACHED"; room: string }
  | { type: "SIGNALING_STATE"; connected: boolean; url?: string };

/**
 * Builds the initial UI state snapshot.
 * @internal
 */
export const initialMediasoupSessionControllerState = (
  initial?: Partial<MediasoupSessionControllerState>,
): MediasoupSessionControllerState => ({
  peerId: initial?.peerId,
  room: initial?.room,
  joined: initial?.joined ?? false,
  signalingConnected: initial?.signalingConnected ?? false,
  signalingUrl: initial?.signalingUrl,
  hasIdentity: initial?.hasIdentity ?? false,
});

/**
 * Pure reducer for controller UI state updates.
 * @internal
 */
export const reduceMediasoupSessionControllerState = (
  state: MediasoupSessionControllerState,
  action: MediasoupSessionControllerStateAction,
): MediasoupSessionControllerState => {
  switch (action.type) {
    case "IDENTITY":
      return {
        ...state,
        peerId: action.peerId,
        hasIdentity: true,
      };
    case "ROOM_ATTACHED":
      return {
        ...state,
        joined: true,
        room: action.room,
      };
    case "ROOM_DETACHED":
      return {
        ...state,
        joined: false,
        room: action.room,
      };
    case "SIGNALING_STATE":
      return {
        ...state,
        signalingConnected: action.connected,
        signalingUrl: action.url ?? state.signalingUrl,
        joined: action.connected ? state.joined : false,
      };
    default:
      return state;
  }
};
