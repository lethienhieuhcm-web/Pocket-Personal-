package one.lethanhdong.dac.player

/**
 * 4.4: Logic badge chất lượng audio — nguồn → DAC (kiểu HiBy/UAPP).
 *
 * Badge hiện những gì đo được THẬT, không đoán:
 * - Định dạng (FLAC/WAV/MP3...) từ mimeType/tên file.
 * - Bit depth: chỉ khi đọc được từ header file (jaudiotagger, file local).
 * - Sample rate: từ ExoPlayer Format (đã parse container).
 * Ví dụ: "FLAC • 24-bit • 96 kHz → USB DAC".
 */
object AudioFormat {

    /** Nhãn định dạng từ mimeType/tên file — tách từ TrackAdapter (single source). */
    fun formatLabel(mimeType: String, title: String): String {
        val mt = mimeType.lowercase()
        val t = title.lowercase()
        return when {
            "flac" in mt || t.endsWith(".flac") -> "FLAC"
            "wav" in mt || t.endsWith(".wav") -> "WAV"
            "mp3" in mt || "mpeg" in mt -> "MP3"
            "m4a" in mt || "mp4" in mt || t.endsWith(".m4a") -> "M4A"
            "ogg" in mt || "opus" in mt -> "OGG"
            "aiff" in mt || t.endsWith(".aiff") -> "AIFF"
            "dsd" in mt || t.endsWith(".dsf") -> "DSD"
            else -> "AUDIO"
        }
    }

    /** 96000 → "96 kHz", 44100 → "44.1 kHz". */
    fun formatSampleRate(hz: Int): String =
        if (hz % 1000 == 0) "${hz / 1000} kHz"
        else String.format("%.1f kHz", hz / 1000.0)

    /**
     * Badge đầy đủ. Các field null = không đo được → bỏ qua, không bịa.
     * viaUsbDac=true: thêm "→ USB DAC" (bit-perfect); false: chỉ hiện nguồn.
     */
    fun badgeText(
        format: String,
        bitDepth: Int?,
        sampleRateHz: Int?,
        viaUsbDac: Boolean,
    ): String {
        val parts = mutableListOf(format)
        if (bitDepth != null && bitDepth > 0) parts.add("$bitDepth-bit")
        if (sampleRateHz != null && sampleRateHz > 0) parts.add(formatSampleRate(sampleRateHz))
        val src = parts.joinToString(" • ")
        return if (viaUsbDac) "$src → USB DAC" else src
    }
}
