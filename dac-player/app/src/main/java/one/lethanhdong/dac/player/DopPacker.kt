package one.lethanhdong.dac.player

/**
 * DopPacker — pack DSD thành frame PCM theo chuẩn DoP v1.1 (DSD over PCM).
 *
 * Chuẩn DoP v1.1 (dop.js.org — public standard, không bịa):
 * - Mỗi sample PCM 24-bit chứa: 16 bit DSD + 8 bit marker
 * - Marker luân phiên 0x05 / 0xFA theo từng sample (DAC dùng để nhận diện DoP)
 * - Byte DSD trong DSF lưu LSB-first, phải đảo bit trước khi pack
 * - DSD64 (2.8224 MHz) / 16 = 176.4 kHz PCM
 * - DSD128 (5.6448 MHz) / 16 = 352.8 kHz PCM
 * - Stereo: kênh trái/phải xen kẽ theo từng sample
 *
 * Spec P3 7.1: app-level, không đụng driver. Driver USB chỉ thấy PCM
 * 176.4kHz/24-bit bình thường; DAC tự nhận marker và chuyển sang DSD mode.
 *
 * Tham khảo: plan Phase 1 của tác giả decent-player (DSD_SUPPORT.md);
 * HiBy `check dop dsd` (mổ 17/10).
 */
object DopPacker {

    /** Marker DoP luân phiên theo từng sample. */
    const val MARKER_A: Byte = 0x05
    const val MARKER_B: Byte = 0xFA.toByte()

    /** Tỉ lệ DSD rate / PCM rate trong DoP — luôn là 16 theo chuẩn. */
    const val DOP_RATIO = 16

    /**
     * Đảo bit trong 1 byte (DSF lưu DSD LSB-first, DoP cần MSB-first).
     * Bảng tra cứu nhanh thay vì loop 8 lần.
     */
    private val BIT_REVERSE_TABLE: ByteArray = ByteArray(256) { i ->
        var v = i
        var r = 0
        repeat(8) {
            r = (r shl 1) or (v and 1)
            v = v shr 1
        }
        r.toByte()
    }

    /** Đảo bit 1 byte DSD. */
    fun reverseBits(b: Byte): Byte = BIT_REVERSE_TABLE[b.toInt() and 0xFF]

    /**
     * Pack 1 byte DSD (8 bit) thành 1 sample PCM 24-bit (3 bytes, little-endian).
     *
     * Layout 24-bit (LSB first trên wire):
     *   byte0 = 8 bit DSD thấp (sau khi đảo bit)
     *   byte1 = 8 bit DSD cao (sau khi đảo bit)
     *   byte2 = marker (0x05 hoặc 0xFA)
     *
     * @param dsdByte 1 byte DSD thô từ file DSF (chưa đảo bit)
     * @param marker MARKER_A hoặc MARKER_B (luân phiên mỗi sample)
     * @param out mảng đích, tối thiểu offset+3 bytes
     * @param offset vị trí ghi
     */
    fun packSample(dsdByte: Byte, marker: Byte, out: ByteArray, offset: Int) {
        // DoP v1.1: 16 bit DSD = 2 byte DSD liên tiếp, nhưng ở mức byte đơn
        // ta pack 8 bit vào nửa dưới của 16-bit word. Caller ghép 2 byte
        // DSD thành 1 sample 24-bit qua packStereoFrame().
        // Hàm này pack 8 bit DSD vào byte0, byte1 = 0, byte2 = marker.
        // (Dùng cho mono hoặc khi caller tự ghép.)
        val reversed = reverseBits(dsdByte)
        out[offset] = reversed
        out[offset + 1] = 0
        out[offset + 2] = marker
    }

    /**
     * Pack 1 frame stereo hoàn chỉnh: 2 byte DSD (L+R) → 2 sample PCM 24-bit.
     *
     * Theo DoP v1.1 stereo: mỗi kênh 16 bit DSD = 2 byte, pack thành
     * 1 sample 24-bit/kênh. Tổng 1 frame = 6 bytes (3 bytes × 2 kênh).
     *
     * @param dsdLeft 2 byte DSD kênh trái (liên tiếp trong file)
     * @param dsdRight 2 byte DSD kênh phải
     * @param markerA marker cho sample đầu, marker còn lại tự luân phiên
     * @param out mảng đích, tối thiểu offset+6 bytes
     * @param offset vị trí ghi
     */
    fun packStereoFrame(
        dsdLeft: ByteArray,
        dsdRight: ByteArray,
        markerA: Byte,
        out: ByteArray,
        offset: Int
    ) {
        require(dsdLeft.size == 2 && dsdRight.size == 2) {
            "Mỗi kênh cần đúng 2 byte DSD cho 1 sample DoP 24-bit"
        }
        val markerB = if (markerA == MARKER_A) MARKER_B else MARKER_A

        // Kênh trái: byte0 = DSD[0] đảo bit, byte1 = DSD[1] đảo bit, byte2 = marker
        out[offset] = reverseBits(dsdLeft[0])
        out[offset + 1] = reverseBits(dsdLeft[1])
        out[offset + 2] = markerA

        // Kênh phải: marker luân phiên
        out[offset + 3] = reverseBits(dsdRight[0])
        out[offset + 4] = reverseBits(dsdRight[1])
        out[offset + 5] = markerB
    }

    /**
     * Tính PCM sample rate tương đương cho DoP từ DSD rate.
     * DSD64 (2822400) → 176400, DSD128 (5644800) → 352800.
     */
    fun dopSampleRate(dsdRateHz: Int): Int {
        require(dsdRateHz % DOP_RATIO == 0) {
            "DSD rate $dsdRateHz không chia hết cho $DOP_RATIO"
        }
        return dsdRateHz / DOP_RATIO
    }

    /**
     * Kiểm tra 1 buffer PCM có phải DoP hợp lệ không (để test).
     * Quét marker ở mỗi byte thứ 3 (offset 2, 5, 8...), phải luân phiên 05/FA.
     */
    fun isValidDopStream(pcm: ByteArray, frameSize: Int = 3): Boolean {
        if (pcm.size < frameSize || pcm.size % frameSize != 0) return false
        var expectA = true
        var i = frameSize - 1
        while (i < pcm.size) {
            val expected = if (expectA) MARKER_A else MARKER_B
            if (pcm[i] != expected) return false
            expectA = !expectA
            i += frameSize
        }
        return true
    }
}
