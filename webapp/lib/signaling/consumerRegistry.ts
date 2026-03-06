/**
 * Consumer registry for mapping producers to consumers and peer ids.
 * Isolated so signaling can delegate cleanup and media-close notifications.
 */
import type { Consumer } from "mediasoup-client/lib/Consumer";
import type { AppData } from "mediasoup-client/lib/types";

/** @internal @category Internals */
export type MediaKind = "audio" | "video";

/** @internal @category Internals */
export class ConsumerRegistry {
  private audioConsumers: Record<string, Consumer> = {};
  private videoConsumers: Record<string, Consumer> = {};
  private consumerByProducerId: Record<string, string[]> = {};
  private producerToPeerId: Record<string, string> = {};
  private consumerAppData: Record<string, AppData | undefined> = {};
  private getPeerMediaClosedHandler: () =>
    | ((peerId: string, mediaType: MediaKind, appData?: AppData) => void)
    | undefined;

  constructor(
    getPeerMediaClosedHandler: () =>
      | ((peerId: string, mediaType: MediaKind, appData?: AppData) => void)
      | undefined,
  ) {
    this.getPeerMediaClosedHandler = getPeerMediaClosedHandler;
  }

  /**
   * Adds consumer mappings for producer->consumer and producer->peer indexes.
   *
   * @param consumer - Consumer instance.
   * @param producerId - Producer id backing this consumer.
   * @param producerPeerId - Peer id owning the producer.
   * @returns `void`.
   */
  addConsumer(consumer: Consumer, producerId: string, producerPeerId: string) {
    if (consumer.kind === "audio") {
      this.audioConsumers[consumer.id] = consumer;
    } else if (consumer.kind === "video") {
      this.videoConsumers[consumer.id] = consumer;
    }
    if (consumer.appData === undefined) {
      console.warn(`Consumer ${consumer.id} missing appData`);
    }
    this.consumerAppData[consumer.id] = consumer.appData;
    if (!this.consumerByProducerId[producerId]) {
      this.consumerByProducerId[producerId] = [];
    }
    this.consumerByProducerId[producerId].push(consumer.id);
    this.producerToPeerId[producerId] = producerPeerId;
  }

  /**
   * Closes and removes all consumers linked to one producer id.
   *
   * @param producerId - Producer id whose consumers should be closed.
   * @param mediaType - Optional media type used for fallback warnings.
   * @returns `void`.
   */
  closeConsumersForProducer(producerId: string, mediaType?: MediaKind) {
    const peerId = this.producerToPeerId[producerId];
    const closedKinds = new Set<MediaKind>();
    const consumerIds = this.consumerByProducerId[producerId] || [];
    if (consumerIds.length === 0) {
      delete this.consumerByProducerId[producerId];
      delete this.producerToPeerId[producerId];
      return;
    }
    consumerIds.forEach((consumerId) => {
      const audioConsumer = this.audioConsumers[consumerId];
      if (audioConsumer) {
        const appData = this.consumerAppData[consumerId];
        if (appData === undefined) {
          console.warn(`Missing appData for audio consumer ${consumerId}`);
        }
        audioConsumer.close();
        audioConsumer.track?.stop();
        delete this.audioConsumers[consumerId];
        delete this.consumerAppData[consumerId];
        closedKinds.add("audio");
        const handler = this.getPeerMediaClosedHandler();
        if (peerId && handler) {
          handler(peerId, "audio", appData);
        }
      }
      const videoConsumer = this.videoConsumers[consumerId];
      if (videoConsumer) {
        const appData = this.consumerAppData[consumerId];
        if (appData === undefined) {
          console.warn(`Missing appData for video consumer ${consumerId}`);
        }
        videoConsumer.close();
        videoConsumer.track?.stop();
        delete this.videoConsumers[consumerId];
        delete this.consumerAppData[consumerId];
        closedKinds.add("video");
        const handler = this.getPeerMediaClosedHandler();
        if (peerId && handler) {
          handler(peerId, "video", appData);
        }
      }
    });
    delete this.consumerByProducerId[producerId];
    if (!closedKinds.size && peerId && mediaType) {
      console.warn(
        `Missing appData for closed ${mediaType} producer ${producerId}`,
      );
    }
    delete this.producerToPeerId[producerId];
  }

  /**
   * Closes all consumers associated with producers owned by one peer.
   *
   * @param peerId - Producer-owner peer id.
   * @returns `void`.
   */
  closeConsumersForPeer(peerId: string) {
    const producerIds = Object.entries(this.producerToPeerId)
      .filter(([, producerPeerId]) => producerPeerId === peerId)
      .map(([producerId]) => producerId);
    producerIds.forEach((producerId) =>
      this.closeConsumersForProducer(producerId),
    );
  }

  /**
   * Ensures producer->peer mapping exists when producer ownership becomes known late.
   *
   * @param producerId - Producer id.
   * @param peerId - Producer-owner peer id.
   * @returns `void`.
   */
  ensureProducerPeer(producerId: string, peerId: string) {
    if (!this.producerToPeerId[producerId]) {
      this.producerToPeerId[producerId] = peerId;
    }
  }

  /**
   * Closes all tracked consumers and clears producer mapping indexes.
   *
   * @returns `void`.
   */
  closeAllConsumers() {
    const producerIds = Object.keys(this.consumerByProducerId);
    producerIds.forEach((producerId) => this.closeConsumersForProducer(producerId));
  }
}
