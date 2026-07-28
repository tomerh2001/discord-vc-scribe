const SOURCE_RATE = 48_000;
const SOURCE_FRAME_BYTES = 2 * 2; // 16-bit stereo

/**
 * Convert raw 48kHz 16-bit stereo PCM (what Discord's Opus decoder emits)
 * into a 48kHz mono WAV buffer. Resampling to the model's rate is left to
 * the STT engine, whose polyphase resampler beats anything we'd do here.
 */
export function pcmToWavMono(pcm: Buffer): Buffer {
	const frames = Math.floor(pcm.length / SOURCE_FRAME_BYTES);
	const data = Buffer.alloc(frames * 2);

	for (let i = 0; i < frames; i++) {
		const offset = i * SOURCE_FRAME_BYTES;
		const sample = Math.round((pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 2);
		data.writeInt16LE(sample, i * 2);
	}

	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(SOURCE_RATE, 24);
	header.writeUInt32LE(SOURCE_RATE * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(data.length, 40);

	return Buffer.concat([header, data]);
}

/** Duration in milliseconds of a raw 48kHz 16-bit stereo PCM buffer. */
export function pcmDurationMs(pcm: Buffer): number {
	return (pcm.length / (SOURCE_RATE * SOURCE_FRAME_BYTES)) * 1000;
}
