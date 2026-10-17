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
            "dsd" in mt || t.endsWith(".dsf") || t.endsWith(".dff") -> "DSD"
            else -> "AUDIO"
        }
    }

    /**
     * Nhãn DSD từ DoP sample rate: 176400 → "DSD64", 352800 → "DSD128", 705600 → "DSD256".
     * Trả về null nếu không phải rate DoP chuẩn.
     */
    fun dsdLabel(dopRateHz: Int): String? = when (dopRateHz) {
        176400 -> "DSD64"
        352800 -> "DSD128"
        705600 -> "DSD256"
        else -> null
    }

    /** File có phải DSD không (dựa vào tên file). */
    fun isDsdFile(title: String): Boolean {
        val t = title.lowercase()
        return t.endsWith(".dsf") || t.endsWith(".dff")
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

    /**
     * Badge cho DSD qua DoP — hiện đúng signal path theo triết lý "Trái Tim Nguyên Chất".
     * Ví dụ: "DSD64 → DoP → USB DAC".
     * Không hiện "176.4 kHz" vì đó là rate PCM của DoP, không phải rate DSD gốc.
     */
    fun dsdBadgeText(dsdLabel: String, viaUsbDac: Boolean): String {
        val src = "$dsdLabel → DoP"
        return if (viaUsbDac) "$src → USB DAC" else src
    }
}
