const PCM_WAV_MIME_TYPE = "audio/wav";
const VOICEBOX_SAMPLE_RATE = 16_000;
const VOICEBOX_CHANNELS = 1;
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SAMPLE = 2;

export class VoiceAudioNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceAudioNormalizationError";
  }
}

function abortError(): DOMException {
  return new DOMException("Voice transcription was cancelled", "AbortError");
}

function isVoiceAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function encodePcmWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const frames = samples.length;
  const dataBytes = frames * WAV_BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(
    new ArrayBuffer(WAV_HEADER_BYTES + dataBytes),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, VOICEBOX_CHANNELS, true);
  view.setUint32(24, VOICEBOX_SAMPLE_RATE, true);
  view.setUint32(28, VOICEBOX_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(32, WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(34, WAV_BYTES_PER_SAMPLE * 8, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.max(-1, Math.min(1, samples[frame] ?? 0));
    view.setInt16(
      WAV_HEADER_BYTES + frame * WAV_BYTES_PER_SAMPLE,
      Math.round(sample * 32767),
      true,
    );
  }
  return bytes;
}

async function renderVoiceboxInput(decoded: AudioBuffer): Promise<Float32Array> {
  const frames = Math.max(
    1,
    Math.ceil(decoded.duration * VOICEBOX_SAMPLE_RATE),
  );
  const renderer = new OfflineAudioContext(
    VOICEBOX_CHANNELS,
    frames,
    VOICEBOX_SAMPLE_RATE,
  );
  const source = renderer.createBufferSource();
  source.buffer = decoded;
  source.connect(renderer.destination);
  source.start();
  const rendered = await renderer.startRendering();
  return rendered.getChannelData(0);
}

export interface VoiceEnergyAnalysis {
  peakRms: number;
  meanRms: number;
  isNearSilence: boolean;
}

export interface NormalizeVoiceRecordingWithAnalysisResult {
  file: File;
  analysis: VoiceEnergyAnalysis;
}

const SILENCE_PEAK_RMS_THRESHOLD = 0.01;
const SILENCE_MEAN_RMS_THRESHOLD = 0.003;
const ENERGY_WINDOW_MS = 50;
const ENERGY_HOP_MS = 25;

export function analyzeVoiceEnergy(
  samples: Float32Array,
  sampleRate: number,
): VoiceEnergyAnalysis {
  const windowSize = Math.max(
    1,
    Math.round((ENERGY_WINDOW_MS / 1000) * sampleRate),
  );
  const hopSize = Math.max(1, Math.round((ENERGY_HOP_MS / 1000) * sampleRate));
  let peakRms = 0;
  let rmsSum = 0;
  let windowCount = 0;

  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(start + windowSize, samples.length);
    let sumSquares = 0;
    let count = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
      count += 1;
    }
    if (count === 0) break;
    const rms = Math.sqrt(sumSquares / count);
    if (rms > peakRms) {
      peakRms = rms;
    }
    rmsSum += rms;
    windowCount += 1;
  }

  if (windowCount === 0) {
    return { peakRms: 0, meanRms: 0, isNearSilence: true };
  }

  const meanRms = rmsSum / windowCount;
  const isNearSilence =
    peakRms < SILENCE_PEAK_RMS_THRESHOLD &&
    meanRms < SILENCE_MEAN_RMS_THRESHOLD;
  return { peakRms, meanRms, isNearSilence };
}

export async function normalizeVoiceRecordingToWavWithAnalysis(args: {
  blob: Blob;
  sourceMimeType: string;
  signal?: AbortSignal;
}): Promise<NormalizeVoiceRecordingWithAnalysisResult> {
  if (isVoiceAbortRequested(args.signal)) {
    throw abortError();
  }
  const AudioContextConstructor = window.AudioContext;
  if (AudioContextConstructor === undefined) {
    throw new VoiceAudioNormalizationError(
      "This browser cannot convert microphone audio for Arc Voice.",
    );
  }

  const context = new AudioContextConstructor();
  try {
    const decoded = await context.decodeAudioData(await args.blob.arrayBuffer());
    if (isVoiceAbortRequested(args.signal)) {
      throw abortError();
    }
    const samples = await renderVoiceboxInput(decoded);
    if (isVoiceAbortRequested(args.signal)) {
      throw abortError();
    }
    const analysis = analyzeVoiceEnergy(samples, VOICEBOX_SAMPLE_RATE);
    const file = new File([encodePcmWav(samples)], "recording.wav", {
      type: PCM_WAV_MIME_TYPE,
    });
    return { file, analysis };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new VoiceAudioNormalizationError(
      `Arc Voice cannot convert recorded audio of type "${args.sourceMimeType || "unknown"}" to PCM WAV.`,
    );
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function normalizeVoiceRecordingToWav(args: {
  blob: Blob;
  sourceMimeType: string;
  signal?: AbortSignal;
}): Promise<File> {
  const { file } = await normalizeVoiceRecordingToWavWithAnalysis(args);
  return file;
}
