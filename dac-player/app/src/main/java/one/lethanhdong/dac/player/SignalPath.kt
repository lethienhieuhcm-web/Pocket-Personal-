package one.lethanhdong.dac.player

/**
 * SignalPath — đánh giá đường tín hiệu từ file đến DAC.
 *
 * Học từ pistolame (assess_signal_path) + Roon (UI).
 * Pure function: cho input, trả về kết quả đánh giá — không side-effect.
 *
 * 5 khâu: File → Decode → Volume → USB → DAC
 * Mỗi khâu có trạng thái bit-perfect riêng + lý do cụ thể khi không đạt.
 */
object SignalPath {

    /** Một khâu trong đường tín hiệu. */
    data class Stage(
        /** ID: "file", "decode", "volume", "usb", "dac" */
        val id: String,
        /** Tên hiển thị: "Tệp", "Giải mã", "Âm lượng", "USB", "DAC" */
        val title: String,
        /** Chi tiết: "FLAC · 24-bit · 96kHz" */
        val detail: String,
        /** Chi tiết phụ (optional): "Stereo" */
        val subDetail: String? = null,
        /** true = bit-perfect (xanh), false = đã chạm bits (vàng) */
        val isBitPerfect: Boolean,
        /** Lý do khi không bit-perfect (vd "Đã chuyển đổi định dạng") */
        val warning: String? = null
    )

    /** Kết quả đánh giá tổng. */
    data class Result(
        /** Đúng 5 khâu, theo thứ tự File → Decode → Volume → USB → DAC */
        val stages: List<Stage>,
        /** true chỉ khi cả 5 khâu đều bit-perfect */
        val isBitPerfect: Boolean,
        /** ID các khâu bị vàng */
        val touchedStages: List<String>
    )

    /**
     * Đánh giá đường tín hiệu.
     *
     * @param fileFormat Format file: "FLAC", "DSF", "DFF", "WAV", "MP3"...
     * @param bitDepth Bit depth: 16, 24, 32 (null nếu không biết)
     * @param sampleRateHz Sample rate: 44100, 96000... (null nếu không biết)
     * @param channels Số kênh: 2 = Stereo (null nếu không biết)
     * @param dsdMethod Chế độ DSD: 0=Native, 1=DoP, 2=PCM (từ DacSettings.currentDsdMethod)
     * @param volumePercent Volume 0-100 (từ DacSettings.getVolume)
     * @param hasHardwareVolume Có volume phần cứng không (từ UsbVolumeController)
     * @param bufferUrbs Buffer USB (từ DacSettings.getBufferUrbs)
     * @param dacName Tên DAC (từ UsbDevice.productName, null nếu chưa biết)
     * @param dacSampleRateHz Rate DAC đang chạy (null = dùng rate file làm proxy) [suy luận]
     */
    fun assess(
        fileFormat: String,
        bitDepth: Int?,
        sampleRateHz: Int?,
        channels: Int?,
        dsdMethod: Int,
        volumePercent: Int,
        hasHardwareVolume: Boolean,
        bufferUrbs: Int,
        dacName: String?,
        dacSampleRateHz: Int?
    ): Result {
        val stages = mutableListOf<Stage>()

        // 1. File — luôn xanh (là nguồn)
        val channelLabel = when (channels) {
            1 -> "Mono"
            2 -> "Stereo"
            in 3..8 -> "$channels kênh"
            else -> null
        }
        val fileDetail = buildString {
            append(fileFormat)
            if (bitDepth != null) append(" · $bitDepth-bit")
            if (sampleRateHz != null) append(" · ${formatRate(sampleRateHz)}")
        }
        stages.add(Stage(
            id = "file",
            title = "Tệp",
            detail = fileDetail,
            subDetail = channelLabel,
            isBitPerfect = true
        ))

        // 2. Decode
        val isDsdFile = fileFormat.uppercase() in setOf("DSF", "DFF")
        val (decodeDetail, decodeSub, decodeOk, decodeWarn) = when {
            !isDsdFile -> Quad("Trực tiếp", "Không chuyển đổi", true, null)
            dsdMethod == 1 -> Quad("DoP", "DSD qua PCM", true, null) // 1 = DoP
            dsdMethod == 0 -> Quad("DSD Native", "Trực tiếp", true, null) // 0 = Native
            else -> Quad( // 2 = PCM fallback
                "DSD → PCM",
                "DSD64 → 88.2kHz · 24-bit",
                false,
                "Đã chuyển đổi định dạng"
            )
        }
        stages.add(Stage(
            id = "decode",
            title = "Giải mã",
            detail = decodeDetail,
            subDetail = decodeSub,
            isBitPerfect = decodeOk,
            warning = decodeWarn
        ))

        // 3. Volume
        val (volDetail, volOk, volWarn) = when {
            !hasHardwareVolume -> Triple("Phần mềm", false, "Dùng volume phần mềm")
            volumePercent >= 100 -> Triple("100% · Phần cứng", true, null)
            else -> Triple("$volumePercent% · Phần cứng", false, "Đã giảm âm lượng")
        }
        stages.add(Stage(
            id = "volume",
            title = "Âm lượng",
            detail = volDetail,
            isBitPerfect = volOk,
            warning = volWarn
        ))

        // 4. USB — luôn xanh (isochronous bit-perfect)
        stages.add(Stage(
            id = "usb",
            title = "USB",
            detail = "Isochronous",
            subDetail = "Buffer $bufferUrbs",
            isBitPerfect = true
        ))

        // 5. DAC
        val effectiveDacRate = dacSampleRateHz ?: sampleRateHz // [suy luận] v1 dùng rate file
        val dacOk = effectiveDacRate == sampleRateHz || sampleRateHz == null
        val dacDetail = dacName ?: "DAC"
        val dacSub = if (effectiveDacRate != null) formatRate(effectiveDacRate) else null
        stages.add(Stage(
            id = "dac",
            title = "DAC",
            detail = dacDetail,
            subDetail = dacSub,
            isBitPerfect = dacOk,
            warning = if (!dacOk) "DAC chạy ở rate khác" else null
        ))

        val touched = stages.filter { !it.isBitPerfect }.map { it.id }
        return Result(
            stages = stages,
            isBitPerfect = touched.isEmpty(),
            touchedStages = touched
        )
    }

    /** Format sample rate: 44100 → "44.1 kHz", 96000 → "96 kHz". */
    private fun formatRate(hz: Int): String {
        return if (hz % 1000 == 0) {
            "${hz / 1000} kHz"
        } else {
            String.format("%.1f kHz", hz / 1000f)
        }
    }

    /** Helper cho 4 giá trị. */
    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)
}
