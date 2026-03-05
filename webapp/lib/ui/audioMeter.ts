/**
 * Audio meter helper shared by uplink and downlink panels.
 * Isolated so audio visualization logic is reused without UI coupling.
 */
/** @category Architecture */
export type AudioMeter = {
  /** Begin measuring a track and updating the bound level element. */
  start: (track: MediaStreamTrack) => void;
  /** Stop measuring and reset the level element. */
  stop: () => void;
};

/**
 * Creates a simple audio level meter for a MediaStreamTrack.
 * @category Architecture
 */
export function createAudioMeter(levelEl: HTMLDivElement): AudioMeter {
  let audioContext: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let sourceNode: MediaStreamAudioSourceNode | undefined;
  let meterTimer: number | undefined;

  const stop = () => {
    if (sourceNode) sourceNode.disconnect();
    if (analyser) analyser.disconnect();
    if (audioContext) {
      audioContext.close().catch(() => undefined);
    }
    if (meterTimer) window.clearInterval(meterTimer);
    sourceNode = undefined;
    analyser = undefined;
    audioContext = undefined;
    meterTimer = undefined;
    levelEl.style.width = "4%";
  };

  const start = (track: MediaStreamTrack) => {
    stop();
    try {
      audioContext = new AudioContext();
      const stream = new MediaStream([track]);
      sourceNode = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      sourceNode.connect(analyser);
      const dataArray = new Uint8Array(analyser.fftSize);
      const updateIntervalMs = 200;
      const update = () => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i += 1) {
          const centered = (dataArray[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const percent = Math.min(100, Math.max(4, rms * 120));
        levelEl.style.width = `${percent}%`;
      };
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => undefined);
      }
      meterTimer = window.setInterval(update, updateIntervalMs);
    } catch (err) {
      console.warn("Audio meter failed", err);
      stop();
    }
  };

  return { start, stop };
}
