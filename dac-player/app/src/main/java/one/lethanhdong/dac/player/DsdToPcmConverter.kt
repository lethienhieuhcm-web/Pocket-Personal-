package one.lethanhdong.dac.player

/**
 * DsdToPcmConverter — chuyển DSD (1-bit) thành PCM bằng software.
 *
 * Spec P3 7.3: DSD→PCM fallback. Đối chiếu 3 app (uapp.md/neutron.md/hiby.md):
 * cả 3 đều làm DSD→PCM bằng bước convert riêng (UAPP `libaudsd2pcm.so`,
 * HiBy native attr `dsd_mode`), KHÔNG dùng FFmpeg decoder.
 *
 * Cách làm: FIR low-pass filter + decimate.
 * - DSD64 (2.8224 MHz) → PCM 88.2 kHz (decimate 32)
 * - DSD128 (5.6448 MHz) → PCM 176.4 kHz (decimate 32)
 * - DSD256 (11.2896 MHz) → PCM 352.8 kHz (decimate 32)
 *
 * Filter: 32-tap FIR, Hamming window, cutoff ~24kHz (cho 88.2kHz output).
 * DSD bit 0 → -1.0, bit 1 → +1.0, convolve với filter, scale ra 24-bit PCM.
 *
 * v1: Kotlin pure, đủ cho DSD64/128. Nếu cần performance thì tách native lib
 * sau (như `libaudsd2pcm.so` của UAPP).
 */
object DsdToPcmConverter {

    /** Tỉ lệ decimate: DSD rate / PCM rate = 32 (chuẩn cho mọi DSD rate). */
    const val DECIMATION = 32

    /** Số tap của FIR filter. */
    private const val TAPS = 32

    /**
     * FIR filter taps — Hamming window, cutoff 0.27 * Nyquist.
     * Tính sẵn để không tính lại mỗi lần convert.
     */
    private val filterTaps: DoubleArray by lazy {
        val taps = DoubleArray(TAPS)
        val cutoff = 0.27 // normalized (0.5 = Nyquist)
        val m = (TAPS - 1) / 2.0
        for (i in 0 until TAPS) {
            val n = i - m
            // Sinc
            val sinc = if (n == 0.0) 2 * cutoff
                       else Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n)
            // Hamming window
            val w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (TAPS - 1))
            taps[i] = sinc * w
        }
        // Chuẩn hoá: tổng = 1.0 (gain = 1 ở DC)
        val sum = taps.sum()
        for (i in taps.indices) taps[i] /= sum
        taps
    }

    /**
     * Tính PCM sample rate từ DSD rate.
     * DSD64 (2822400) → 88200, DSD128 → 176400, DSD256 → 352800.
     */
    fun pcmSampleRate(dsdRateHz: Int): Int = dsdRateHz / DECIMATION

    /**
     * Convert 1 block DSD thành PCM.
     *
     * @param dsdBytes DSD raw, mỗi byte = 8 bit DSD (LSB-first như DSF)
     * @param dsdOffset offset bắt đầu trong dsdBytes
     * @param dsdLen số byte DSD cần convert (phải là bội số của DECIMATION/8 = 4)
     * @param pcmOut buffer output PCM 24-bit little-endian (3 bytes/sample)
     * @param pcmOffset offset bắt đầu trong pcmOut
     * @return số byte PCM đã ghi vào pcmOut
     */
    fun convert(
        dsdBytes: ByteArray,
        dsdOffset: Int,
        dsdLen: Int,
        pcmOut: ByteArray,
        pcmOffset: Int
    ): Int {
        require(dsdLen % 4 == 0) { "dsdLen phải là bội số của 4, gặp $dsdLen" }

        // Số sample PCM output = (dsdLen * 8) / 32
        val pcmSamples = (dsdLen * 8) / DECIMATION

        // Chuyển DSD bytes thành bits (±1.0), LSB-first
        // Zero-pad đầu (TAPS-1) để filter có history
        val totalBits = dsdLen * 8
        val padded = DoubleArray((TAPS - 1) + totalBits)
        var pPos = TAPS - 1
        for (i in 0 until dsdLen) {
            val b = dsdBytes[dsdOffset + i].toInt() and 0xFF
            for (bit in 0 until 8) {
                padded[pPos++] = if (((b shr bit) and 1) == 1) 1.0 else -1.0
            }
        }

        // Convolve + decimate: mỗi 32 DSD bits → 1 PCM sample
        // Output sample s dùng window kết thúc tại bit (TAPS-1) + s*32
        var outPos = pcmOffset
        for (s in 0 until pcmSamples) {
            val base = (TAPS - 1) + s * DECIMATION
            var acc = 0.0
            for (t in 0 until TAPS) {
                acc += padded[base - t] * filterTaps[t]
            }
            // Scale: DSD ±1.0 → PCM 24-bit (±8388607)
            // Nhân 0.5 để tránh clip khi tín hiệu DSD max
            val pcmVal = (acc * 0.5 * 8388607.0).toInt().coerceIn(-8388608, 8388607)

            // Ghi little-endian 24-bit
            pcmOut[outPos++] = (pcmVal and 0xFF).toByte()
            pcmOut[outPos++] = ((pcmVal shr 8) and 0xFF).toByte()
            pcmOut[outPos++] = ((pcmVal shr 16) and 0xFF).toByte()
        }

        return pcmSamples * 3
    }

    /**
     * Convert stereo: 2 kênh DSD → 2 kênh PCM xen kẽ (LRLR...).
     *
     * @param dsdL DSD kênh trái, dsdR DSD kênh phải (cùng độ dài)
     * @return số byte PCM đã ghi (2 kênh xen kẽ)
     */
    fun convertStereo(
        dsdL: ByteArray, lOffset: Int,
        dsdR: ByteArray, rOffset: Int,
        dsdLen: Int,
        pcmOut: ByteArray,
        pcmOffset: Int
    ): Int {
        require(dsdLen % 4 == 0) { "dsdLen phải là bội số của 4" }

        val pcmSamplesPerCh = (dsdLen * 8) / DECIMATION
        // Buffer tạm cho từng kênh
        val tmpL = ByteArray(pcmSamplesPerCh * 3)
        val tmpR = ByteArray(pcmSamplesPerCh * 3)

        convert(dsdL, lOffset, dsdLen, tmpL, 0)
        convert(dsdR, rOffset, dsdLen, tmpR, 0)

        // Xen kẽ LRLR...
        var outPos = pcmOffset
        for (s in 0 until pcmSamplesPerCh) {
            // Kênh L (3 bytes)
            pcmOut[outPos++] = tmpL[s * 3]
            pcmOut[outPos++] = tmpL[s * 3 + 1]
            pcmOut[outPos++] = tmpL[s * 3 + 2]
            // Kênh R (3 bytes)
            pcmOut[outPos++] = tmpR[s * 3]
            pcmOut[outPos++] = tmpR[s * 3 + 1]
            pcmOut[outPos++] = tmpR[s * 3 + 2]
        }

        return pcmSamplesPerCh * 6
    }
}
