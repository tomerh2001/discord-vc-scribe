const SOURCE_RATE = 48_000;
const TARGET_RATE = 16_000;
const RATIO = SOURCE_RATE / TARGET_RATE; // 3
const SOURCE_FRAME_BYTES = 2 * 2; // 16-bit stereo

/**
 * Convert raw 48kHz 16-bit stereo PCM (what Discord's Opus decoder emits)
 * into a 16kHz mono WAV buffer, which is what Whisper-family models expect.
 * Downmixes channels and box-averages every 3 samples as a crude low-pass.
 */
export function pcmToWav16kMono(pcm: Buffer): Buffer {
	const sourceFrames = Math.floor(pcm.length / SOURCE_FRAME_BYTES);
	const targetFrames = Math.floor(sourceFrames / RATIO);
	const data = Buffer.alloc(targetFrames * 2);

	for (let i = 0; i < targetFrames; i++) {
		let acc = 0;
		for (let j = 0; j < RATIO; j++) {
			const offset = (i * RATIO + j) * SOURCE_FRAME_BYTES;
			acc += (pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 2;
		}

		let sample = Math.round(acc / RATIO);
		if (sample > 32_767) sample = 32_767;
		if (sample < -32_768) sample = -32_768;
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
	header.writeUInt32LE(TARGET_RATE, 24);
	header.writeUInt32LE(TARGET_RATE * 2, 28); // byte rate
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
