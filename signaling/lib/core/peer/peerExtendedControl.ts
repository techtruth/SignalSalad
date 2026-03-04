import type { Guid, Peer } from "../../../../types/baseTypes.d.ts";
import type { WsRequestMap } from "../../protocol/signalingIoValidation.js";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import { buildPeerMuteRequestedMessage } from "../../protocol/websocketResponseBuilders.js";

type MutePeerMessage = WsRequestMap["mutePeer"];

/** Peer-state read API required by extended control commands. */
export type PeerExtendedControlPeerStatePort = {
  requirePeer: (peerId: Guid, context: string) => Peer;
};

/** Dependencies for peer control commands that sit outside room/transport lifecycle. */
export type PeerExtendedControlContext = {
  peerState: PeerExtendedControlPeerStatePort;
  signalingMessenger: Pick<SignalingMessenger, "sendWebsocketMessage">;
  mediaSession: {
    setPeerServerMute(peerId: Guid, muted: boolean): void;
  };
};

/**
 * Handles peer control-plane commands that are not transport creation/room membership.
 */
export class PeerExtendedControl {
  private readonly context: PeerExtendedControlContext;

  constructor(context: PeerExtendedControlContext) {
    this.context = context;
  }

  /** Routes a mute request to either client-directed signaling or server-side mute control. */
  mutePeer(message: MutePeerMessage) {
    const requestingPeer = this.context.peerState.requirePeer(
      message.requestingPeer,
      "mutePeer",
    );
    const targetPeer = this.context.peerState.requirePeer(
      message.targetPeer,
      "mutePeer",
    );

    if (message.scope === "client") {
      this.context.signalingMessenger.sendWebsocketMessage(
        targetPeer.transportSignal,
        "peerMuteRequested",
        buildPeerMuteRequestedMessage(requestingPeer.id, message.muted),
      );
      return;
    }

    this.context.mediaSession.setPeerServerMute(targetPeer.id, message.muted);
  }
}
