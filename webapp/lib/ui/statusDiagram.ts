/**
 * Status diagram UI: draws servers, routers, pipes, and peers from status payloads.
 * Kept separate to isolate SVG rendering from controller and signaling logic.
 */

const setAttr = (el: Element, name: string, value: string | number) =>
  el.setAttribute(name, String(value));

const shortId = (id: string) => id.split("-")[0];

const formatBytes = (value: number) => {
  if (value < 1024) return `${Math.round(value)} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const formatRate = (value: number) => {
  if (value < 1000) return `${Math.round(value)} bps`;
  const kbps = value / 1000;
  if (kbps < 1000) return `${kbps.toFixed(1)} kbps`;
  const mbps = kbps / 1000;
  return `${mbps.toFixed(2)} Mbps`;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const metricFromStats = (stats: Record<string, number> | null | undefined, keys: string[]) => {
  if (!stats) return undefined;
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
};

const readJitterMs = (stats: Record<string, number> | null | undefined) => {
  const directMs = metricFromStats(stats, ["jitterMs", "jitter_ms"]);
  if (typeof directMs === "number") return Math.max(0, directMs);
  const raw = metricFromStats(stats, ["jitter", "jitterBufferDelay"]);
  if (typeof raw !== "number") return 0;
  return raw <= 2 ? Math.max(0, raw * 1000) : Math.max(0, raw);
};

const readLossPercent = (stats: Record<string, number> | null | undefined) => {
  const direct = metricFromStats(stats, ["packetLossPct", "lossPct", "loss", "packetLoss"]);
  if (typeof direct === "number") {
    return direct <= 1 ? clamp(direct * 100, 0, 100) : clamp(direct, 0, 100);
  }
  const fractionLost = metricFromStats(stats, ["fractionLost"]);
  if (typeof fractionLost === "number") {
    return fractionLost <= 1
      ? clamp(fractionLost * 100, 0, 100)
      : clamp((fractionLost / 256) * 100, 0, 100);
  }
  const packetsLost = metricFromStats(stats, ["packetsLost"]);
  const packetsRecv = metricFromStats(stats, ["packetsReceived", "packetsRecv"]);
  if (typeof packetsLost === "number" && typeof packetsRecv === "number" && packetsRecv > 0) {
    return clamp((packetsLost / packetsRecv) * 100, 0, 100);
  }
  return 0;
};

const readRttMs = (stats: Record<string, number> | null | undefined) => {
  const directMs = metricFromStats(stats, ["rttMs", "roundTripTimeMs"]);
  if (typeof directMs === "number") return Math.max(0, directMs);
  const raw = metricFromStats(stats, ["rtt", "roundTripTime"]);
  if (typeof raw !== "number") return 0;
  return raw <= 2 ? Math.max(0, raw * 1000) : Math.max(0, raw);
};

const lagScore = (stats: Record<string, number> | null | undefined) => {
  const jitterNorm = clamp(readJitterMs(stats) / 30, 0, 1);
  const lossNorm = clamp(readLossPercent(stats) / 5, 0, 1);
  const rttNorm = clamp(readRttMs(stats) / 400, 0, 1);
  return clamp(jitterNorm * 0.45 + lossNorm * 0.4 + rttNorm * 0.15, 0, 1);
};

const lagColor = (score: number) => {
  if (score >= 0.85) return "#991b1b";
  if (score >= 0.65) return "#dc2626";
  if (score >= 0.45) return "#f97316";
  if (score >= 0.25) return "#eab308";
  return "#22c55e";
};

const lagLabel = (score: number) => `${Math.round(score * 100)}%`;

const aggregateLag = (statsList: Array<Record<string, number>>) => {
  if (statsList.length === 0) return 0;
  const total = statsList.reduce((sum, stats) => sum + lagScore(stats), 0);
  return clamp(total / statsList.length, 0, 1);
};

const effectiveBitrate = (stats: Record<string, number> | null | undefined) => {
  if (!stats) return 0;
  const direct = metricFromStats(stats, ["bitrate", "availableOutgoingBitrate"]);
  if (typeof direct === "number") return Math.max(0, direct);
  const rtp = (typeof stats.rtpSendBitrate === "number" ? stats.rtpSendBitrate : 0) +
    (typeof stats.rtpRecvBitrate === "number" ? stats.rtpRecvBitrate : 0);
  if (rtp > 0) return rtp;
  return (typeof stats.sendBitrate === "number" ? stats.sendBitrate : 0) +
    (typeof stats.recvBitrate === "number" ? stats.recvBitrate : 0);
};

const bandwidthStrokeWidth = (bitrateBps: number) => {
  const kbps = Math.max(0, bitrateBps) / 1000;
  return clamp(1 + Math.log2(1 + kbps) * 0.45, 1, 6);
};

const hashPacket = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const makeText = (
  text: string,
  x: number | string,
  y: number | string,
  color = "black",
  size = 10,
) => {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  setAttr(t, "x", x);
  setAttr(t, "y", y);
  setAttr(t, "fill", color);
  setAttr(t, "font-size", size);
  setAttr(t, "dominant-baseline", "middle");
  return Object.assign(t, { textContent: text });
};

const makeRect = ({
  x,
  y,
  width,
  height,
  fill,
  id,
  stroke,
}: {
  x: number | string;
  y: number | string;
  width: number | string;
  height: number | string;
  fill: string;
  id?: string;
  stroke?: string;
}) => {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  const resolvedStroke = stroke ?? "black";
  if (id) setAttr(rect, "id", id);
  setAttr(rect, "x", x);
  setAttr(rect, "y", y);
  setAttr(rect, "width", width);
  setAttr(rect, "height", height);
  setAttr(rect, "fill", fill);
  if (resolvedStroke) {
    setAttr(rect, "stroke", resolvedStroke);
    setAttr(rect, "stroke-width", "1");
  }
  return rect;
};

const makeLine = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  className?: string,
) => {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  setAttr(line, "x1", x1);
  setAttr(line, "y1", y1);
  setAttr(line, "x2", x2);
  setAttr(line, "y2", y2);
  setAttr(line, "stroke", color);
  setAttr(line, "stroke-width", width);
  if (className) setAttr(line, "class", className);
  return line;
};

const makeMarker = (id: string, color: string) => {
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  setAttr(marker, "id", id);
  setAttr(marker, "viewBox", "0 0 10 10");
  setAttr(marker, "refX", 8);
  setAttr(marker, "refY", 5);
  setAttr(marker, "markerWidth", 4);
  setAttr(marker, "markerHeight", 4);
  setAttr(marker, "orient", "auto-start-reverse");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  setAttr(path, "d", "M 0 0 L 10 5 L 0 10 z");
  setAttr(path, "fill", color);
  marker.appendChild(path);
  return marker;
};

/** @category Architecture */
export type LoadDetail = { avg: number; perCpu: number[] };
/**
 * Snapshot of a router dump used for SVG rendering.
 * @category Architecture
 */
export type RouterDumpEntry = {
  origin: string;
  room: string;
  serverId: string;
  mode: "ingress" | "egress";
  routers: Array<{
    id: string;
    transportIds: string[];
    rtpObserverIds: string[];
    mapProducerIdConsumerIds: Array<{ key: string; values: string[] }>;
    mapConsumerIdProducerId: Array<{ key: string; value: string }>;
    mapProducerIdObserverIds: Array<{ key: string; values: string[] }>;
    mapDataProducerIdDataConsumerIds: Array<{ key: string; values: string[] }>;
    mapDataConsumerIdDataProducerId: Array<{ key: string; value: string }>;
    transportStats?: Record<string, number>;
  }>;
  pipeTransports: Array<{
    id: string;
    tuple: {
      localIp: string;
      localAddress?: string;
      localPort: number;
      remoteIp: string;
      remotePort: number;
      protocol: string;
    };
  }>;
  webrtcTransportStats: Record<string, Record<string, number>>;
  pipeTransportStats: Record<string, Record<string, number>>;
  error?: string;
};
/**
 * System status payload consumed by the status diagram.
 * @category Architecture
 */
export type StatusData = {
  routingTable: Record<string, { ingress: string[]; egress: string[] }>;
  ingress?: string[] | Record<string, unknown>;
  egress?: string[] | Record<string, unknown>;
  peers: Record<
    string,
    {
      room?: string;
      isLobby?: boolean;
      isParticipant?: boolean;
      isSpectator?: boolean;
      transportEgress: Record<string, string>;
      transportIngress: Record<string, string>;
    }
  >;
  pipes: Array<{
    ingress: string;
    egress: string;
    room: string;
    ingressPort: number;
    egressPort: number;
    producerIds?: string[];
  }>;
  pipesObserved?: Array<{
    ingress: string;
    egress: string;
    room: string;
    ingressPort: number;
    egressPort: number;
    producerIds?: string[];
  }>;
  ingressRegions: Record<string, string[]>;
  egressRegions: Record<string, string[]>;
  ingressLoad: Record<string, Record<string, number>>;
  egressLoad: Record<string, Record<string, number>>;
  ingressLoadDetail: Record<string, Record<string, LoadDetail>>;
  egressLoadDetail: Record<string, Record<string, LoadDetail>>;
  routerDumps: Record<string, RouterDumpEntry>;
  diagnosticsRecent?: Array<{
    at: string;
    severity: "warn" | "error";
    category:
      | "websocketRequest"
      | "netsocketCommand"
      | "producerLifecycle"
      | "transportLifecycle"
      | "mediaServerLifecycle";
    message: string;
    details?: string;
    context?: Record<string, string>;
  }>;
};

/**
 * Minimal controller contract consumed by `StatusLegend`.
 *
 * Using a narrow shape keeps demo-ui docs independent from full controller docs.
 * @category Architecture
 */
export type StatusLegendController = {
  on(
    event: "transportSignalingStatus",
    listener: (isConnected: boolean) => void,
  ): void;
  on(event: "systemStatus", listener: (data: StatusData) => void): void;
  connectSignaling(url: string): void;
  disconnectSignaling(): void;
};

/**
 * SVG snapshot renderer for system status frames.
 * Translates a full status payload into shapes without retaining state.
 * @category Implementer API
 */
export class StatusDiagram {
  svg: SVGSVGElement;
  tooltip: HTMLDivElement;
  diagnosticsControls: HTMLDivElement;
  diagnosticsPeerFilter: HTMLInputElement;
  diagnosticsRoomFilter: HTMLInputElement;
  diagnosticsBox: HTMLTextAreaElement;
  latestDiagnostics: NonNullable<StatusData["diagnosticsRecent"]>;

  constructor() {
    const existing = document.getElementById("statusDiagram");
    if (existing instanceof SVGSVGElement) {
      this.svg = existing;
    } else {
      const svg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      svg.setAttribute("id", "statusDiagram");
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("version", "1.1");
      this.svg = svg;
    }

    const existingTip = document.getElementById("diagramTooltip");
    if (existingTip instanceof HTMLDivElement) {
      this.tooltip = existingTip;
    } else {
      const tip = document.createElement("div");
      tip.id = "diagramTooltip";
      tip.className = "diagram-tooltip";
      tip.style.display = "none";
      this.tooltip = tip;
    }

    this.latestDiagnostics = [];

    const controls = document.createElement("div");
    controls.className = "status-diagnostics-controls";
    controls.style.display = "flex";
    controls.style.gap = "8px";
    controls.style.marginTop = "8px";

    const peerFilter = document.createElement("input");
    peerFilter.type = "text";
    peerFilter.placeholder = "Filter peer (id)";
    peerFilter.style.flex = "1";

    const roomFilter = document.createElement("input");
    roomFilter.type = "text";
    roomFilter.placeholder = "Filter room";
    roomFilter.style.flex = "1";

    controls.appendChild(peerFilter);
    controls.appendChild(roomFilter);
    this.diagnosticsControls = controls;
    this.diagnosticsPeerFilter = peerFilter;
    this.diagnosticsRoomFilter = roomFilter;

    const existingDiagnostics = document.getElementById("statusDiagnostics");
    if (existingDiagnostics instanceof HTMLTextAreaElement) {
      this.diagnosticsBox = existingDiagnostics;
    } else {
      const diagnosticsBox = document.createElement("textarea");
      diagnosticsBox.id = "statusDiagnostics";
      diagnosticsBox.className = "status-diagnostics";
      diagnosticsBox.readOnly = true;
      diagnosticsBox.rows = 10;
      diagnosticsBox.placeholder = "Diagnostics will appear here...";
      diagnosticsBox.style.width = "100%";
      diagnosticsBox.style.marginTop = "8px";
      diagnosticsBox.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
      diagnosticsBox.style.fontSize = "12px";
      diagnosticsBox.style.lineHeight = "1.35";
      this.diagnosticsBox = diagnosticsBox;
    }

    const rerenderDiagnostics = () => {
      this.renderDiagnosticsReadout();
    };
    this.diagnosticsPeerFilter.addEventListener("input", rerenderDiagnostics);
    this.diagnosticsRoomFilter.addEventListener("input", rerenderDiagnostics);

    this.svg.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.copySvgToClipboard().catch((err) => {
        console.warn("StatusDiagram: failed to copy svg", err);
      });
    });
  }

  private serializeSvg(): string {
    const rect = this.svg.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    let viewBox = `0 0 ${width} ${height}`;
    try {
      const bbox = this.svg.getBBox();
      if (
        Number.isFinite(bbox.x) &&
        Number.isFinite(bbox.y) &&
        Number.isFinite(bbox.width) &&
        Number.isFinite(bbox.height) &&
        bbox.width > 0 &&
        bbox.height > 0
      ) {
        viewBox = `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`;
      }
    } catch {
      // Use the rendered size when the bbox is unavailable.
    }
    const cloned = this.svg.cloneNode(true) as SVGSVGElement;
    if (!cloned.getAttribute("xmlns")) {
      cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    if (!cloned.getAttribute("version")) {
      cloned.setAttribute("version", "1.1");
    }
    cloned.setAttribute("width", String(width));
    cloned.setAttribute("height", String(height));
    cloned.setAttribute("viewBox", viewBox);
    cloned.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return new XMLSerializer().serializeToString(cloned);
  }

  private async copySvgToClipboard() {
    const svgMarkup = this.serializeSvg();
    if (typeof navigator.clipboard?.writeText !== "function") {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(svgMarkup);
  }

  /**
   * Attach the diagram SVG and tooltip to a parent container.
   */
  mount(parent: HTMLElement = document.body) {
    parent.appendChild(this.svg);
    parent.appendChild(this.diagnosticsControls);
    parent.appendChild(this.diagnosticsBox);
    parent.appendChild(this.tooltip);
  }

  private updateDiagnostics(data: StatusData) {
    this.latestDiagnostics = Array.isArray(data.diagnosticsRecent)
      ? data.diagnosticsRecent
      : [];
    this.renderDiagnosticsReadout();
  }

  private renderDiagnosticsReadout() {
    if (!this.latestDiagnostics.length) {
      this.diagnosticsBox.value = "No diagnostics recorded.";
      return;
    }
    const peerFilter = this.diagnosticsPeerFilter.value.trim().toLowerCase();
    const roomFilter = this.diagnosticsRoomFilter.value.trim().toLowerCase();

    const filtered = this.latestDiagnostics.filter((event) => {
      const contextValues = event.context
        ? Object.values(event.context).join(" ")
        : "";
      const haystack = `${event.message} ${event.details || ""} ${contextValues}`.toLowerCase();
      const peerMatches = !peerFilter || haystack.includes(peerFilter);
      const roomMatches = !roomFilter || haystack.includes(roomFilter);
      return peerMatches && roomMatches;
    });

    if (!filtered.length) {
      this.diagnosticsBox.value =
        "No diagnostics match current filters.";
      return;
    }

    const lines = filtered.map((event) => {
      const contextEntries = event.context
        ? Object.entries(event.context)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")
        : "";
      const details = event.details ? ` | ${event.details}` : "";
      const context = contextEntries ? ` | ${contextEntries}` : "";
      return `[${event.at}] ${event.severity.toUpperCase()} ${event.category}: ${event.message}${details}${context}`;
    });
    this.diagnosticsBox.value = lines.join("\n");
    this.diagnosticsBox.scrollTop = this.diagnosticsBox.scrollHeight;
  }

  /**
   * Render a complete diagram from a single status payload.
   */
  update(data: StatusData) {
    this.updateDiagnostics(data);
    const svgContainer = this.svg;
    svgContainer.innerHTML = "";

    const tooltip = this.tooltip;
    const hideTooltip = () => {
      tooltip.style.display = "none";
    };
    const attachTooltip = (el: Element, detail?: string) => {
      if (!detail) return;
      const show = (evt: MouseEvent) => {
        const rect = (evt.target as Element).getBoundingClientRect();
        const centerX = rect.left + rect.width / 2 + window.scrollX;
        const centerY = rect.top + rect.height / 2 + window.scrollY;
        tooltip.textContent = detail;
        tooltip.style.left = `${centerX + 12}px`;
        tooltip.style.top = `${centerY + 12}px`;
        tooltip.style.display = "block";
      };
      el.addEventListener("mousemove", show);
      el.addEventListener("mouseleave", hideTooltip);
    };
    const setRoomRouterHighlight = (roomId: string, on: boolean) => {
      const nodes = svgContainer.querySelectorAll(
        `[data-router-room="${roomId}"]`,
      );
      nodes.forEach((node) => {
        if (node instanceof SVGElement) {
          node.classList.toggle("active", on);
        }
      });
    };

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.appendChild(makeMarker("arrow-blue", "blue"));
    defs.appendChild(makeMarker("arrow-green", "green"));
    defs.appendChild(makeMarker("arrow-purple", "purple"));
    defs.appendChild(makeMarker("arrow-black", "black"));
    svgContainer.appendChild(defs);
    const packet = {
      capturedAt: new Date().toISOString(),
      status: data,
    };
    const packetJson = JSON.stringify(packet);
    const packetHash = hashPacket(packetJson);
    setAttr(svgContainer, "data-packet-id", packetHash);
    setAttr(svgContainer, "data-packet-ts", packet.capturedAt);
    setAttr(svgContainer, "data-packet-hash", packetHash);
    setAttr(svgContainer, "data-packet-bytes", packetJson.length);

    const metadata = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "metadata",
    );
    setAttr(metadata, "id", "systemStatusSnapshot");
    metadata.textContent = packetJson;
    svgContainer.appendChild(metadata);

    const makeBadge = (
      text: string,
      x: number,
      y: number,
      className = "badge",
      detail?: string,
    ) => {
      const group = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      const textEl = makeText(text, x + 6, y + 9, "#0d1b2a", 9);
      setAttr(textEl, "text-anchor", "start");
      const textLen = Math.max(10, text.length * 6);
      const rect = makeRect({
        x,
        y,
        width: textLen + 6,
        height: 14,
        fill: "rgba(255,255,255,0.85)",
        stroke: "#cbd5e1",
      });
      setAttr(rect, "rx", 6);
      setAttr(rect, "ry", 6);
      group.appendChild(rect);
      group.appendChild(textEl);
      setAttr(group, "class", className);
      if (detail) {
        attachTooltip(group, detail);
      }
      return group;
    };
    const serverNodes = new Map<
      string,
      { x: number; y: number; width: number; height: number }
    >();
    const roomLinkAnchor = (node: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ({
      x: node.x + node.width / 2,
      y: node.y + node.height / 2 + 14,
    });
    const ingressLoad = data.ingressLoad ?? {};
    const egressLoad = data.egressLoad ?? {};
    const serverLoad = (
      kind: "ingress" | "egress",
      serverId: string,
      region: string,
    ) => {
      const loadTable = kind === "ingress" ? ingressLoad : egressLoad;
      const regionTable = loadTable[region] ?? {};
      const loadVal = regionTable[serverId];
      if (typeof loadVal !== "number" || !Number.isFinite(loadVal)) {
        return 0;
      }
      return Math.round(loadVal);
    };
    const addServerBox = (
      type: "Ingress" | "Egress",
      id: string,
      x: number,
      y: number,
      fill: string,
      typeColor: string,
    ) => {
      const rect = makeRect({
        x,
        y,
        width: boxWidth,
        height: boxHeight,
        fill,
        id: `${id}-${type.toLowerCase()}Server`,
      });
      svgContainer.appendChild(rect);
      serverNodes.set(`${id}:${type.toLowerCase()}`, {
        x,
        y,
        width: boxWidth,
        height: boxHeight,
      });

      const typeTextY = type === "Ingress" ? y + boxHeight - 8 : y + 12;
      const typeText = makeText(type, x + 6, typeTextY, typeColor, 9);
      svgContainer.appendChild(typeText);

      const labelText = makeText(
        shortId(id),
        x + boxWidth / 2,
        y + boxHeight / 2,
        "black",
        12,
      );
      setAttr(labelText, "text-anchor", "middle");
      svgContainer.appendChild(labelText);
    };

    const routingTable = data.routingTable ?? {};
    const peersById = data.peers ?? {};
    const pipes = new Array<{
      ingress: string;
      egress: string;
      room: string;
      ingressPort: number;
      egressPort: number;
      producerIds?: string[];
    }>();
    const ingressRegions = data.ingressRegions ?? {};
    const egressRegions = data.egressRegions ?? {};
    const ingressLoadDetail = data.ingressLoadDetail ?? {};
    const egressLoadDetail = data.egressLoadDetail ?? {};
    const routerDumpsRecord = data.routerDumps ?? {};
    const peerRooms = new Map<string, string | null>();
    Object.entries(peersById).forEach(([peerId, peerInfo]) => {
      const room =
        typeof peerInfo.room === "string" && peerInfo.room.trim().length > 0
          ? peerInfo.room.trim()
          : null;
      peerRooms.set(peerId, room);
    });

    // Layout constants
    const boxWidth = 200;
    const boxHeight = 100;
    const verticalServerOffset = 200;
    const topPadding = 100;
    const dumpRooms = new Set<string>();
    const dumpRoomServers = new Map<
      string,
      { ingress: Set<string>; egress: Set<string> }
    >();
    Object.values(routerDumpsRecord).forEach((dump) => {
      dumpRooms.add(dump.room);
      if (!dumpRoomServers.has(dump.room)) {
        dumpRoomServers.set(dump.room, {
          ingress: new Set<string>(),
          egress: new Set<string>(),
        });
      }
      const entry = dumpRoomServers.get(dump.room);
      if (!entry) {
        return;
      }
      if (dump.mode === "ingress") {
        entry.ingress.add(dump.serverId);
      } else {
        entry.egress.add(dump.serverId);
      }
    });
    const rooms = Array.from(
      new Set<string>([...Object.keys(routingTable), ...dumpRooms]),
    );
    const peers = Array.from(peerRooms.keys());
    const svgBounds = svgContainer.getBoundingClientRect();
    const svgWidth = svgBounds.width;
    const svgHeight = svgBounds.height;
    if (
      !Number.isFinite(svgWidth) ||
      svgWidth <= 0 ||
      !Number.isFinite(svgHeight) ||
      svgHeight <= 0
    ) {
      return;
    }
    const roomColumnPercent = 0;
    const roomColumnWidth = 150;
    const roomColumnGap = 60;
    const roomColumnX = (roomColumnPercent / 100) * svgWidth;
    const marginX = Math.max(25, roomColumnX + roomColumnWidth + roomColumnGap);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const updatedText = makeText(
      `Updated: ${new Date().toLocaleTimeString()} ${timeZone}`,
      svgWidth - 10,
      svgHeight - 16,
      "#444",
      10,
    );
    setAttr(updatedText, "text-anchor", "end");
    svgContainer.appendChild(updatedText);

    // Regions (egress/ingress blocks)
    const regionNames = Array.from(
      new Set<string>([
        ...Object.keys(egressRegions),
        ...Object.keys(ingressRegions),
      ]),
    );
    regionNames.sort();
    const regionPadding = 16;
    const regionGap = 40;
    const regionRowGap = 60;
    let regionXCursor = marginX - regionPadding;
    let regionYCursor = topPadding;
    let currentRowHeight = 0;
    regionNames.forEach((region) => {
      const egressServers = Array.isArray(egressRegions[region])
        ? egressRegions[region]
        : [];
      const ingressServers = Array.isArray(ingressRegions[region])
        ? ingressRegions[region]
        : [];
      const maxServers = Math.max(
        1,
        egressServers.length,
        ingressServers.length,
      );
      const regionWidth = boxWidth * maxServers + regionPadding * 2;
      const regionHeight =
        boxHeight * 2 + verticalServerOffset + regionPadding * 2;
      const totalRegionHeight = regionHeight + 24;
      const maxRegionX = svgWidth - 20;
      if (
        regionXCursor + regionWidth > maxRegionX &&
        regionXCursor > marginX - regionPadding
      ) {
        regionXCursor = marginX - regionPadding;
        regionYCursor += currentRowHeight + regionRowGap;
        currentRowHeight = 0;
      }
      const regionX = regionXCursor;
      const regionY = regionYCursor;
      const groupY = regionY + regionPadding;
      const regionInnerX = regionX + regionPadding;

      const backgroundRect = makeRect({
        x: regionX,
        y: regionY,
        width: regionWidth,
        height: regionHeight,
        fill: "rgba(79, 70, 229, 0.04)",
        stroke: "black",
      });
      setAttr(backgroundRect, "stroke-width", "2");
      svgContainer.appendChild(backgroundRect);

      const regionLabel = makeText(
        `Region: ${region}`,
        regionX + regionWidth / 2,
        regionY - 12,
        "black",
        12,
      );
      setAttr(regionLabel, "text-anchor", "middle");
      setAttr(regionLabel, "dominant-baseline", "central");
      setAttr(regionLabel, "font-weight", "600");
      svgContainer.appendChild(regionLabel);

      egressServers.forEach((egress, eIndex) => {
        const x = regionInnerX + boxWidth * eIndex;
        const y = groupY;
        addServerBox("Egress", egress, x, y, "lightblue", "#0a3a5e");
        const load = serverLoad("egress", egress, region);
        const regionDetail = egressLoadDetail[region] ?? {};
        const detail = regionDetail[egress];
        const perCpu = Array.isArray(detail?.perCpu) ? detail.perCpu : [];
        const avg = typeof detail?.avg === "number" ? detail.avg : 0;
        const badgeTitle = [
          `avg ${avg.toFixed(1)}% (${perCpu.length} cores)`,
          ...perCpu.map((v, idx) => {
            const value = typeof v === "number" ? v : 0;
            return `cpu${idx} ${value.toFixed(1)}%`;
          }),
        ].join("\n");
        const badge = makeBadge(
          `load ${load.toFixed(1)}%`,
          x + boxWidth - 60,
          y + 8,
          "badge server-badge",
          badgeTitle,
        );
        svgContainer.appendChild(badge);
      });

      ingressServers.forEach((ingress, iIndex) => {
        const x = regionInnerX + boxWidth * iIndex;
        const y = groupY + boxHeight + verticalServerOffset;
        addServerBox("Ingress", ingress, x, y, "lightgreen", "#0f5a1f");
        const load = serverLoad("ingress", ingress, region);
        const regionDetail = ingressLoadDetail[region] ?? {};
        const detail = regionDetail[ingress];
        const perCpu = Array.isArray(detail?.perCpu) ? detail.perCpu : [];
        const avg = typeof detail?.avg === "number" ? detail.avg : 0;
        const badgeTitle = [
          `avg ${avg.toFixed(1)}% (${perCpu.length} cores)`,
          ...perCpu.map((v, idx) => {
            const value = typeof v === "number" ? v : 0;
            return `cpu${idx} ${value.toFixed(1)}%`;
          }),
        ].join("\n");
        const badge = makeBadge(
          `load ${load.toFixed(1)}%`,
          x + boxWidth - 60,
          y + boxHeight - 18,
          "badge server-badge",
          badgeTitle,
        );
        svgContainer.appendChild(badge);
      });
      regionXCursor += regionWidth + regionGap;
      currentRowHeight = Math.max(currentRowHeight, totalRegionHeight);
    });

    const routerNodes = new Map<string, { x: number; y: number }>();
    const routerStackCounts = new Map<string, number>();
    serverNodes.forEach((_node, key) => {
      routerStackCounts.set(key, 0);
    });
    const routerDumps = Object.values(routerDumpsRecord);
    const routerDumpByKey = new Map<string, RouterDumpEntry>();
    routerDumps.forEach((dump) => {
      routerDumpByKey.set(`${dump.room}:${dump.serverId}:${dump.mode}`, dump);
    });
    const observedPipes = Array.isArray(data.pipesObserved)
      ? data.pipesObserved
      : [];
    const trackedPipes = Array.isArray(data.pipes) ? data.pipes : [];
    const pipeKey = (pipe: {
      ingress: string;
      egress: string;
      room: string;
      ingressPort: number;
      egressPort: number;
    }) =>
      [
        pipe.room,
        pipe.ingress,
        pipe.egress,
        pipe.ingressPort,
        pipe.egressPort,
      ].join(":");
    const observedKeys = new Set(observedPipes.map(pipeKey));
    const trackedKeys = new Set(trackedPipes.map(pipeKey));
    observedPipes.forEach((pipe) => {
      if (!trackedKeys.has(pipeKey(pipe))) {
        console.warn("StatusDiagram: observed pipe missing from signaling", pipe);
      }
    });
    trackedPipes.forEach((pipe) => {
      if (!observedKeys.has(pipeKey(pipe))) {
        console.warn("StatusDiagram: signaling pipe missing from dumps", pipe);
      }
    });
    const combinedKeys = new Set<string>();
    const appendPipe = (pipe: {
      ingress: string;
      egress: string;
      room: string;
      ingressPort: number;
      egressPort: number;
      producerIds?: string[];
    }) => {
      const key = pipeKey(pipe);
      if (combinedKeys.has(key)) {
        return;
      }
      combinedKeys.add(key);
      pipes.push(pipe);
    };
    trackedPipes.forEach(appendPipe);
    observedPipes.forEach(appendPipe);
    const findPipeDetails = (dump: RouterDumpEntry, port: number) => {
      const pipeTransports = Array.isArray(dump.pipeTransports)
        ? dump.pipeTransports
        : [];
      const match = pipeTransports.find((pipe) => {
        const tuple = pipe.tuple;
        if (!tuple) return false;
        const localPort =
          typeof tuple.localPort === "number" ? tuple.localPort : null;
        const remotePort =
          typeof tuple.remotePort === "number" ? tuple.remotePort : null;
        if (localPort === null || remotePort === null) {
          return false;
        }
        return localPort === port || remotePort === port;
      });
      const pipeId =
        typeof match?.id === "string" && match.id.trim().length > 0
          ? match.id.trim()
          : null;
      if (!pipeId) return null;
      const statsEntry = dump.pipeTransportStats?.[pipeId];
      const stats =
        statsEntry && typeof statsEntry === "object"
          ? (statsEntry as Record<string, number>)
          : undefined;
      return {
        id: pipeId,
        tuple: match.tuple,
        stats,
      };
    };
    const appendPipeTooltipLines = (
      lines: Array<string>,
      label: "ingress" | "egress",
      detail: {
        id: string;
        tuple: RouterDumpEntry["pipeTransports"][number]["tuple"];
        stats?: Record<string, number>;
      },
    ) => {
      lines.push(`${label} pipe ${detail.id}`);
      const tuple = detail.tuple;
      if (tuple) {
        lines.push(
          `${label} tuple ${tuple.localIp}:${tuple.localPort} -> ${tuple.remoteIp}:${tuple.remotePort}`,
        );
      }
      const stats = detail.stats;
      if (!stats) {
        return;
      }
      const sendRate = stats.rtpSendBitrate;
      const recvRate = stats.rtpRecvBitrate;
      if (typeof sendRate === "number" && typeof recvRate === "number") {
        lines.push(
          `${label} rtp ${formatRate(sendRate)} / ${formatRate(recvRate)}`,
        );
      }
      const bytesSent = stats.rtpBytesSent;
      const bytesRecv = stats.rtpBytesReceived;
      if (typeof bytesSent === "number" && typeof bytesRecv === "number") {
        lines.push(
          `${label} bytes ${formatBytes(bytesSent)} / ${formatBytes(bytesRecv)}`,
        );
      }
    };
    routerDumps.forEach((dump) => {
      const serverKey = `${dump.serverId}:${dump.mode}`;
      const serverNode = serverNodes.get(serverKey);
      if (!serverNode) {
        console.warn(`StatusDiagram: missing server node ${serverKey}`);
        return;
      }
      const baseX = serverNode.x;
      const baseY = serverNode.y;
      const nodeSize = 28;
      const nodeRadius = nodeSize / 2;
      const routers = Array.isArray(dump.routers) ? dump.routers : [];
      routers.forEach((router) => {
        const stackIndex = routerStackCounts.get(serverKey) ?? 0;
        routerStackCounts.set(serverKey, stackIndex + 1);
        const nodeX = baseX + 6 + stackIndex * (nodeSize + 4);
        const nodeY =
          dump.mode === "ingress"
            ? baseY + 6
            : baseY + boxHeight - nodeSize - 4;
        const nodeCenterX = nodeX + nodeRadius;
        const nodeCenterY = nodeY + nodeRadius;
        const transportStatsEntries = Object.values(dump.webrtcTransportStats ?? {}).filter(
          (entry): entry is Record<string, number> =>
            !!entry && typeof entry === "object",
        );
        const routerLag = aggregateLag(transportStatsEntries);
        const routerLagColor = lagColor(routerLag);
        const node = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        setAttr(node, "cx", nodeCenterX);
        setAttr(node, "cy", nodeCenterY);
        setAttr(node, "r", nodeRadius);
        setAttr(node, "fill", routerLagColor);
        setAttr(node, "stroke", "#7f1d1d");
        setAttr(node, "class", "router-node");
        setAttr(node, "data-router-room", dump.room);
        svgContainer.appendChild(node);

        const routerId =
          typeof router.id === "string" && router.id.trim().length > 0
            ? router.id.trim()
            : null;
        if (!routerId) {
          console.warn(
            `StatusDiagram: missing router id for ${dump.room}:${dump.serverId}:${dump.mode}`,
          );
          return;
        }
        const routerLabel = routerId.slice(0, 4);
        const roomLabel = makeText(
          routerLabel,
          nodeCenterX,
          nodeCenterY,
          routerLag >= 0.65 ? "#fff" : "#111827",
          9,
        );
        setAttr(roomLabel, "text-anchor", "middle");
        svgContainer.appendChild(roomLabel);

        const transportCount = Array.isArray(router.transportIds)
          ? router.transportIds.length
          : 0;
        const producerCount = Array.isArray(router.mapProducerIdConsumerIds)
          ? router.mapProducerIdConsumerIds.length
          : 0;
        const consumerCount = Array.isArray(router.mapConsumerIdProducerId)
          ? router.mapConsumerIdProducerId.length
          : 0;
        const dataProducerCount = Array.isArray(
          router.mapDataProducerIdDataConsumerIds,
        )
          ? router.mapDataProducerIdDataConsumerIds.length
          : 0;
        const dataConsumerCount = Array.isArray(router.mapDataConsumerIdDataProducerId)
          ? router.mapDataConsumerIdDataProducerId.length
          : 0;
        const routerStats = router.transportStats;
        const statsLines =
          routerStats &&
          typeof routerStats.bytesSent === "number" &&
          typeof routerStats.bytesReceived === "number" &&
          typeof routerStats.sendBitrate === "number" &&
          typeof routerStats.recvBitrate === "number" &&
          typeof routerStats.rtpSendBitrate === "number" &&
          typeof routerStats.rtpRecvBitrate === "number"
            ? [
                `bytes sent ${formatBytes(routerStats.bytesSent)}`,
                `bytes recv ${formatBytes(routerStats.bytesReceived)}`,
                `send rate ${formatRate(routerStats.sendBitrate)}`,
                `recv rate ${formatRate(routerStats.recvBitrate)}`,
                `rtp send ${formatRate(routerStats.rtpSendBitrate)}`,
                `rtp recv ${formatRate(routerStats.rtpRecvBitrate)}`,
              ]
            : [];
        const detail = dump.error
          ? `error: ${dump.error}`
          : [
              `router ${routerId}`,
              `room ${dump.room}`,
              `transports ${transportCount}`,
              `producers ${producerCount}`,
              `consumers ${consumerCount}`,
              `data producers ${dataProducerCount}`,
              `data consumers ${dataConsumerCount}`,
              `lag score ${lagLabel(routerLag)}`,
              ...statsLines,
            ].join("\n");
        attachTooltip(node, detail);

        const nodeKey = `${dump.room}:${dump.serverId}:${dump.mode}`;
        if (!routerNodes.has(nodeKey)) {
          routerNodes.set(nodeKey, {
            x: nodeCenterX,
            y: nodeCenterY,
          });
        }
      });
    });

    const roomNodes = new Map<
      string,
      { x: number; y: number; width: number; height: number; centerX: number; centerY: number }
    >();

    // Rooms
    rooms.forEach((room, index) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      setAttr(group, "id", room + "-roomGroup");

      let routingEntry = routingTable[room];
      if (!routingEntry) {
        const ingressServers = new Array<string>();
        const egressServers = new Array<string>();
        Object.values(routerDumpsRecord).forEach((dump) => {
          if (dump.room !== room) {
            return;
          }
          if (dump.mode === "ingress") {
            ingressServers.push(dump.serverId);
          } else {
            egressServers.push(dump.serverId);
          }
        });
        routingEntry = {
          ingress: ingressServers,
          egress: egressServers,
        };
      }
      if (!routingEntry) {
        svgContainer.appendChild(group);
        return;
      }
      const egressList = Array.isArray(routingEntry.egress)
        ? routingEntry.egress
        : [];
      const ingressList = Array.isArray(routingEntry.ingress)
        ? routingEntry.ingress
        : [];
      const roomHeightPct = 100 / rooms.length;
      const squareY = roomHeightPct * index + 7;
      const squareXPercent = roomColumnPercent;
      const squareWidth = roomColumnWidth;
      const hasDump = dumpRooms.has(room);
      if (!hasDump) {
        console.warn("StatusDiagram: room missing from dumps", room);
      }
      const square = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      setAttr(square, "id", room + "-room");
      setAttr(square, "type", "room");
      setAttr(square, "x", `${squareXPercent}%`);
      setAttr(square, "y", `${squareY}%`);
      setAttr(square, "width", squareWidth);
      setAttr(square, "height", `${roomHeightPct}%`);
      setAttr(square, "stroke", hasDump ? "black" : "#dc2626");
      setAttr(square, "stroke-width", "1");
      setAttr(square, "fill", "orange");
      setAttr(square, "data-room", room);
      group.appendChild(square);
      square.addEventListener("mouseenter", () => {
        setRoomRouterHighlight(room, true);
      });
      square.addEventListener("mouseleave", () => {
        setRoomRouterHighlight(room, false);
      });

      const peerCount = Array.from(peerRooms.entries()).filter(
        ([, roomId]) => roomId === room,
      ).length;
      const squarePxX = (squareXPercent / 100) * svgWidth;
      const squarePxY = (squareY / 100) * svgHeight;
      const squarePxWidth = squareWidth;
      const squarePxHeight = (roomHeightPct / 100) * svgHeight;
      roomNodes.set(room, {
        x: squarePxX,
        y: squarePxY,
        width: squarePxWidth,
        height: squarePxHeight,
        centerX: squarePxX + squarePxWidth / 2,
        centerY: squarePxY + squarePxHeight / 2,
      });

      const roomTypeText = makeText(
        "Room",
        squarePxX + 6,
        squarePxY + 14,
        "#7a4200",
        9,
      );
      setAttr(roomTypeText, "text-anchor", "start");
      group.appendChild(roomTypeText);

      const labelText = makeText(
        shortId(room),
        squarePxX + squarePxWidth / 2,
        squarePxY + 30,
        "black",
        12,
      );
      setAttr(labelText, "text-anchor", "middle");
      group.appendChild(labelText);

      const badgeText = `peers: ${peerCount}`;
      const badgeTextLen = Math.max(10, badgeText.length * 6);
      const badgeWidth = badgeTextLen + 6;
      const badgeX = squarePxX + squarePxWidth - badgeWidth - 8;
      const badgeY = squarePxY + 8;
      const roomBadge = makeBadge(
        badgeText,
        badgeX,
        badgeY,
        "badge room-badge",
      );
      group.appendChild(roomBadge);

      const roomNode = roomNodes.get(room);
      if (!roomNode) {
        svgContainer.appendChild(group);
        return;
      }
      const dumpServers = dumpRoomServers.get(room);
      egressList.forEach((egress) => {
        const serverNode = serverNodes.get(`${egress}:egress`);
        if (!serverNode) {
          console.warn(`StatusDiagram: missing server node ${egress}:egress`);
          return;
        }
        const matchesDump = dumpServers?.egress.has(egress);
        if (!matchesDump) {
          console.warn(
            "StatusDiagram: egress missing from dumps",
            room,
            egress,
          );
        }
        const anchor = roomLinkAnchor(serverNode);
        const line = makeLine(
          anchor.x,
          anchor.y,
          roomNode.x + roomNode.width,
          roomNode.centerY,
          matchesDump ? "blue" : "#dc2626",
          2,
          "conditionalHover",
        );
        group.appendChild(line);
      });

      ingressList.forEach((ingress) => {
        const serverNode = serverNodes.get(`${ingress}:ingress`);
        if (!serverNode) {
          console.warn(`StatusDiagram: missing server node ${ingress}:ingress`);
          return;
        }
        const matchesDump = dumpServers?.ingress.has(ingress);
        if (!matchesDump) {
          console.warn(
            "StatusDiagram: ingress missing from dumps",
            room,
            ingress,
          );
        }
        const anchor = roomLinkAnchor(serverNode);
        const line = makeLine(
          anchor.x,
          anchor.y,
          roomNode.x + roomNode.width,
          roomNode.centerY,
          matchesDump ? "green" : "#dc2626",
          2,
          "conditionalHover",
        );
        group.appendChild(line);
      });

      svgContainer.appendChild(group);
    });

    // Network pipes
    pipes.forEach((pipe) => {
      const groupElement = svgContainer.getElementById(pipe.room + "-roomGroup");
      if (!groupElement) {
        console.warn(`StatusDiagram: missing room group ${pipe.room}`);
        return;
      }
      const egressNode = routerNodes.get(
        `${pipe.room}:${pipe.egress}:egress`,
      );
      const ingressNode = routerNodes.get(
        `${pipe.room}:${pipe.ingress}:ingress`,
      );
      if (!egressNode || !ingressNode) {
        console.warn(
          `StatusDiagram: missing router node for pipe ${pipe.room}:${pipe.egress}:${pipe.ingress}`,
        );
        return;
      }

      const pipeOffset = 6;
      const x1 = egressNode.x;
      const y1 = egressNode.y + pipeOffset;
      const x2 = ingressNode.x;
      const y2 = ingressNode.y - pipeOffset;
      const isObserved = observedKeys.has(
        [
          pipe.room,
          pipe.ingress,
          pipe.egress,
          pipe.ingressPort,
          pipe.egressPort,
        ].join(":"),
      );
      const isTracked = trackedKeys.has(
        [
          pipe.room,
          pipe.ingress,
          pipe.egress,
          pipe.ingressPort,
          pipe.egressPort,
        ].join(":"),
      );
      const isMismatch = !(isObserved && isTracked);
      const lineColor = isMismatch ? "#dc2626" : "purple";
      const pipeLine = makeLine(
        x1,
        y1,
        x2,
        y2,
        lineColor,
        1.5,
        "pipe-line",
      );
      const ingressPort =
        typeof pipe.ingressPort === "number"
          ? pipe.ingressPort
          : Number(pipe.ingressPort);
      const egressPort =
        typeof pipe.egressPort === "number"
          ? pipe.egressPort
          : Number(pipe.egressPort);
      if (!Number.isFinite(ingressPort) || !Number.isFinite(egressPort)) {
        return;
      }
      setAttr(
        pipeLine,
        "id",
        pipe.ingress + pipe.egress + pipe.egressPort + pipe.ingressPort,
      );
      setAttr(pipeLine, "stroke-dasharray", "6 4");
      svgContainer.appendChild(pipeLine);

      // Solid hover overlay that follows the same fade timing as other links
      const pipeHighlight = makeLine(
        x1,
        y1,
        x2,
        y2,
        lineColor,
        2,
        "pipe-highlight conditionalHover",
      );
      groupElement.appendChild(pipeHighlight);
      const pipeHitbox = makeLine(
        x1,
        y1,
        x2,
        y2,
        "transparent",
        14,
        "pipe-hitbox",
      );
      groupElement.appendChild(pipeHitbox);

      const ingressDump = routerDumpByKey.get(
        `${pipe.room}:${pipe.ingress}:ingress`,
      );
      const egressDump = routerDumpByKey.get(
        `${pipe.room}:${pipe.egress}:egress`,
      );
      const ingressDetail = ingressDump
        ? findPipeDetails(ingressDump, ingressPort)
        : null;
      const egressDetail = egressDump
        ? findPipeDetails(egressDump, egressPort)
        : null;
      const tooltipLines = new Array<string>();
      tooltipLines.push(`room ${pipe.room}`);
      tooltipLines.push(`ingress ${pipe.ingress}`);
      tooltipLines.push(`egress ${pipe.egress}`);
      tooltipLines.push(`ports ${ingressPort} -> ${egressPort}`);
      if (ingressDetail) {
        appendPipeTooltipLines(tooltipLines, "ingress", ingressDetail);
      }
      if (egressDetail) {
        appendPipeTooltipLines(tooltipLines, "egress", egressDetail);
      }
      const pipeTooltip = tooltipLines.join("\n");
      attachTooltip(pipeLine, pipeTooltip);
      attachTooltip(pipeHighlight, pipeTooltip);
      attachTooltip(pipeHitbox, pipeTooltip);

      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      const labelGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      // Center on the line then lift the label perpendicular to the path
      setAttr(
        labelGroup,
        "transform",
        `translate(${midX} ${midY}) rotate(${angle}) translate(0 -8)`,
      );
      const label = makeText(
        `pipeTransport ${shortId(pipe.egress)}→${shortId(pipe.ingress)}`,
        0,
        0,
        lineColor,
        9,
      );
      setAttr(label, "text-anchor", "middle");
      setAttr(label, "class", "pipe-label");
      labelGroup.appendChild(label);
      svgContainer.appendChild(labelGroup);

      const ingressStats = ingressDetail?.stats;
      const egressStats = egressDetail?.stats;
      if (!ingressStats && !egressStats) {
        return;
      }
      const ingressRate = effectiveBitrate(ingressStats);
      const egressRate = effectiveBitrate(egressStats);
      const pipeRate = Math.max(ingressRate, egressRate);
      const pipeWidth = bandwidthStrokeWidth(pipeRate);
      setAttr(pipeLine, "stroke-width", pipeWidth);
      setAttr(pipeHighlight, "stroke-width", Math.max(2, pipeWidth + 0.75));
      const ingressBytes =
        (typeof ingressStats?.rtpBytesSent === "number"
          ? ingressStats.rtpBytesSent
          : 0) +
        (typeof ingressStats?.rtpBytesReceived === "number"
          ? ingressStats.rtpBytesReceived
          : 0);
      const egressBytes =
        (typeof egressStats?.rtpBytesSent === "number"
          ? egressStats.rtpBytesSent
          : 0) +
        (typeof egressStats?.rtpBytesReceived === "number"
          ? egressStats.rtpBytesReceived
          : 0);
      const statsLabel = makeText(
        `in ${formatRate(ingressRate)} · out ${formatRate(egressRate)}`,
        0,
        0,
        lineColor,
        8,
      );
      setAttr(statsLabel, "text-anchor", "middle");
      setAttr(statsLabel, "class", "pipe-label secondary");
      const statsGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      setAttr(
        statsGroup,
        "transform",
        `translate(${midX} ${midY}) rotate(${angle}) translate(0 6)`,
      );
      statsGroup.appendChild(statsLabel);
      svgContainer.appendChild(statsGroup);
      const statsBytesLabel = makeText(
        `in ${formatBytes(ingressBytes)} · out ${formatBytes(egressBytes)}`,
        0,
        0,
        lineColor,
        8,
      );
      setAttr(statsBytesLabel, "text-anchor", "middle");
      setAttr(statsBytesLabel, "class", "pipe-label secondary");
      const statsBytesGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      setAttr(
        statsBytesGroup,
        "transform",
        `translate(${midX} ${midY}) rotate(${angle}) translate(0 18)`,
      );
      statsBytesGroup.appendChild(statsBytesLabel);
      svgContainer.appendChild(statsBytesGroup);
    });

    // Peers
    peers.forEach((peer, index) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const peerWidthPx = svgWidth / Math.max(peers.length, 1);
      const peerX = peerWidthPx * index;
      const peerHeightPx = 45;
      const peerBottom = peerHeightPx;
      const peerCenterX = peerX + peerWidthPx / 2;
      const peerInfo = peersById[peer];
      if (!peerInfo) {
        return;
      }
      const roomId = peerRooms.get(peer) ?? null;
      const transportEgress = peerInfo.transportEgress ?? {};
      const transportIngress = peerInfo.transportIngress ?? {};
      const peerRect = makeRect({
        x: 0,
        y: 0,
        width: peerWidthPx,
        height: peerHeightPx,
        fill: roomId ? "pink" : "#9ca3af",
      });
      setAttr(peerRect, "type", "peer");
      setAttr(peerRect, "x", peerX);
      setAttr(peerRect, "y", 0);
      setAttr(peerRect, "width", peerWidthPx);
      group.appendChild(peerRect);

      const peerType = makeText("Peer", peerX + 2, 6, "#6b2336", 9);
      setAttr(peerType, "text-anchor", "start");
      group.appendChild(peerType);

      const labelText = makeText(
        shortId(peer),
        peerX + peerWidthPx / 2,
        18,
        "black",
        12,
      );
      setAttr(labelText, "text-anchor", "middle");
      group.appendChild(labelText);

      if (roomId) {
        Object.entries(transportEgress).forEach(([egress, transportId]) => {
          const routerNode = routerNodes.get(`${roomId}:${egress}:egress`);
          if (!routerNode) {
            return;
          }
          const dump = routerDumpByKey.get(`${roomId}:${egress}:egress`);
          const statsTable = dump ? dump.webrtcTransportStats : null;
          const statsEntry = statsTable ? statsTable[transportId] : null;
          const stats =
            statsEntry && typeof statsEntry === "object"
              ? (statsEntry as Record<string, number>)
              : null;
          const rate = effectiveBitrate(stats);
          const bytes =
            (typeof stats?.bytesSent === "number" ? stats.bytesSent : 0) +
            (typeof stats?.rtpBytesSent === "number" ? stats.rtpBytesSent : 0);
          const lag = lagScore(stats);
          const stroke = lagColor(lag);
          const line = makeLine(
            routerNode.x,
            routerNode.y,
            peerCenterX,
            peerBottom,
            stroke,
            bandwidthStrokeWidth(rate),
            "conditionalHover",
          );
          setAttr(line, "marker-end", "url(#arrow-blue)");
          group.appendChild(line);
          if (rate <= 0 || bytes <= 0) {
            return;
          }
          const midX = (routerNode.x + peerCenterX) / 2;
          const midY = (routerNode.y + peerBottom) / 2;
          const label = makeText(
            `↑ ${formatRate(rate)} (${formatBytes(bytes)})`,
            midX,
            midY - 6,
            stroke,
            9,
          );
          setAttr(label, "text-anchor", "middle");
          setAttr(label, "class", "conditionalHover");
          group.appendChild(label);
        });
      }

      if (roomId) {
        Object.entries(transportIngress).forEach(([ingress, transportId]) => {
          const routerNode = routerNodes.get(`${roomId}:${ingress}:ingress`);
          if (!routerNode) {
            return;
          }
          const dump = routerDumpByKey.get(`${roomId}:${ingress}:ingress`);
          const statsTable = dump ? dump.webrtcTransportStats : null;
          const statsEntry = statsTable ? statsTable[transportId] : null;
          const stats =
            statsEntry && typeof statsEntry === "object"
              ? (statsEntry as Record<string, number>)
              : null;
          const rate = effectiveBitrate(stats);
          const bytes =
            (typeof stats?.bytesReceived === "number" ? stats.bytesReceived : 0) +
            (typeof stats?.rtpBytesReceived === "number" ? stats.rtpBytesReceived : 0);
          const lag = lagScore(stats);
          const stroke = lagColor(lag);
          const line = makeLine(
            peerCenterX,
            peerBottom,
            routerNode.x,
            routerNode.y,
            stroke,
            bandwidthStrokeWidth(rate),
            "conditionalHover",
          );
          setAttr(line, "marker-end", "url(#arrow-green)");
          group.appendChild(line);
          if (rate <= 0 || bytes <= 0) {
            return;
          }
          const midX = (routerNode.x + peerCenterX) / 2;
          const midY = (routerNode.y + peerBottom) / 2;
          const label = makeText(
            `↓ ${formatRate(rate)} (${formatBytes(bytes)})`,
            midX,
            midY + 10,
            stroke,
            9,
          );
          setAttr(label, "text-anchor", "middle");
          setAttr(label, "class", "conditionalHover");
          group.appendChild(label);
        });
      }

      if (roomId) {
        const roomNode = roomNodes.get(roomId);
        if (!roomNode) {
          svgContainer.appendChild(group);
          return;
        }
        const line = makeLine(
          roomNode.centerX,
          roomNode.centerY,
          peerCenterX,
          peerBottom,
          "black",
          3,
          "conditionalHover",
        );
        group.appendChild(line);
      }
      svgContainer.appendChild(group);
    });
  }
}

/**
 * Summary legend and signaling controls for the status diagram.
 * @category Implementer API
 */
export class StatusLegend {
  element: HTMLDivElement;

  constructor(
    controller?: StatusLegendController,
    signalingUrl?: string,
  ) {
    const legendWrap = document.createElement("div");
    legendWrap.className = "diagram-legend-wrap";
    const legendContainer = document.createElement("div");
    legendContainer.className = "diagram-legend";
    const makeSummaryRow = (label: string) => {
      const row = document.createElement("div");
      row.className = "legend-row summary-row";
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "summary-value";
      valueEl.textContent = "0";
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      legendContainer.appendChild(row);
      return valueEl;
    };
    const summary = {
      peers: makeSummaryRow("peers"),
      rooms: makeSummaryRow("rooms"),
      regions: makeSummaryRow("regions"),
      ingress: makeSummaryRow("ingress"),
      egress: makeSummaryRow("egress"),
      pipes: makeSummaryRow("router-pipes"),
      netPipes: makeSummaryRow("net-pipes"),
      toServers: makeSummaryRow("to servers"),
      fromServers: makeSummaryRow("from servers"),
    };
    if (controller) {
      let signalingConnected = false;
      const signalRow = document.createElement("div");
      signalRow.className = "diagram-signal";
      const signalDot = document.createElement("span");
      signalDot.className = "status-dot";
      signalDot.title = "signaling websocket";
      const signalLabel = document.createElement("span");
      signalLabel.textContent = "Signaling";
      const signalInput = document.createElement("input");
      signalInput.type = "text";
      signalInput.className = "signal-input";
      signalInput.placeholder = "ws://localhost:8080";
      signalInput.value = signalingUrl ?? "ws://localhost:8080";
      const signalToggle = document.createElement("button");
      signalToggle.type = "button";
      signalToggle.className = "signal-toggle";
      signalToggle.textContent = "Connect";
      signalToggle.disabled = !signalingUrl;

      const updateSignal = (connected: boolean) => {
        signalDot.classList.toggle("on", connected);
        signalToggle.textContent = connected ? "Disconnect" : "Connect";
        signalToggle.classList.toggle("connected", connected);
        const hasUrl = Boolean(signalInput.value.trim());
        signalToggle.disabled = (!hasUrl && !connected);
      };

      controller.on("transportSignalingStatus", (isConnected) => {
        signalingConnected = isConnected;
        updateSignal(isConnected);
      });
      controller.on("systemStatus", (data) => {
        const peers = Object.keys(data.peers || {}).length;
        const rooms = Object.keys(data.routingTable || {}).length;
        const netPipeConnections = Array.isArray(data.pipes)
          ? data.pipes.length
          : 0;
        const ingressCount = Array.isArray(data.ingress)
          ? data.ingress.length
          : Object.keys(data.ingress || {}).length;
        const egressCount = Array.isArray(data.egress)
          ? data.egress.length
          : Object.keys(data.egress || {}).length;
        const regionKeys = new Set<string>([
          ...Object.keys(data.ingressRegions || {}),
          ...Object.keys(data.egressRegions || {}),
        ]);
        let toServers = 0;
        let fromServers = 0;
        let totalPipeTransports = 0;
        Object.values(data.routerDumps || {}).forEach((dump) => {
          totalPipeTransports += Array.isArray(dump.pipeTransports)
            ? dump.pipeTransports.length
            : 0;
          const routers = Array.isArray(dump.routers) ? dump.routers : [];
          routers.forEach((router) => {
            const stats = (
              router as {
                transportStats?: { bytesReceived?: number; bytesSent?: number };
              }
            ).transportStats;
            const bytesReceived =
              typeof stats?.bytesReceived === "number" ? stats.bytesReceived : 0;
            const bytesSent =
              typeof stats?.bytesSent === "number" ? stats.bytesSent : 0;
            toServers += bytesReceived;
            fromServers += bytesSent;
          });
        });
        const localPipeTransports = Math.max(
          0,
          totalPipeTransports - netPipeConnections * 2,
        );
        summary.peers.textContent = String(peers);
        summary.rooms.textContent = String(rooms);
        summary.regions.textContent = String(regionKeys.size);
        summary.ingress.textContent = String(ingressCount);
        summary.egress.textContent = String(egressCount);
        summary.pipes.textContent = `${localPipeTransports} (${totalPipeTransports})`;
        summary.netPipes.textContent = String(netPipeConnections);
        summary.toServers.textContent = formatBytes(toServers);
        summary.fromServers.textContent = formatBytes(fromServers);
      });

      signalToggle.onclick = () => {
        if (signalingConnected) {
          controller.disconnectSignaling();
          return;
        }
        const targetUrl = signalInput.value.trim();
        if (!targetUrl) {
          return;
        }
        controller.connectSignaling(targetUrl);
      };

      signalRow.appendChild(signalDot);
      signalRow.appendChild(signalLabel);
      signalRow.appendChild(signalInput);
      signalRow.appendChild(signalToggle);
      legendWrap.appendChild(signalRow);
    }
    legendWrap.appendChild(legendContainer);
    this.element = legendWrap;
  }

  /**
   * Attach the legend element to a parent container.
   */
  mount(parent: HTMLElement = document.body) {
    parent.appendChild(this.element);
  }
}
