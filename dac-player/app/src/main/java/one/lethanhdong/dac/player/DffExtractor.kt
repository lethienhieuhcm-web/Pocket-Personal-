package one.lethanhdong.dac.player

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import java.io.IOException

/**
 * DffExtractor — đọc file DFF (DSDIFF của Philips) và output PCM
 * chứa DoP (DSD over PCM) để phát qua USB DAC.
 *
 * Format DSDIFF (spec công khai của Philips) — KHÁC DSF ở 2 điểm:
 * 1. Big-endian cho mọi số nguyên (DSF là little-endian)
 * 2. DSD data multiplexed theo SAMPLE: [L0][R0][L1][R1]... (DSF là theo block)
 *
 * Cấu trúc:
 * - "FRM8" (4) + chunkSize (8 BE) + formType "DSD " (4)
 * - Chunk "FVER": version
 * - Chunk "PROP" > "SND ": chứa "FS  " (sample rate, 4 BE),
 *   "CHNL" (số kênh, 2 BE), "CMPR" (kiểu nén)
 * - Chunk "DSD ": DSD raw multiplexed
 *
 * Output: PCM 24-bit little-endian, sample rate = DSD rate / 16 (DoP),
 * mỗi sample đã pack marker 0x05/0xFA qua DopPacker.
 *
 * Spec P3 7.1: DSD DoP app-level v1.
 */
@UnstableApi
class DffExtractor : Extractor {

    companion object {
        private fun fourcc(s: String) = ByteArray(4) { s[it].code.toByte() }
        private val FRM8 = fourcc("FRM8")
        private val DSD_FORM = fourcc("DSD ")
        private val PROP = fourcc("PROP")
        private val SND = fourcc("SND ")
        private val FS = fourcc("FS  ")
        private val CHNL = fourcc("CHNL")
        private val DSD_DATA = fourcc("DSD ")

        fun sniffMagic(input: ExtractorInput): Boolean {
            val buf = ByteArray(4)
            return try {
                input.peekFully(buf, 0, 4)
                buf.contentEquals(FRM8)
            } catch (_: IOException) {
                false
            }
        }
    }

    private var output: ExtractorOutput? = null
    private var trackOutput: TrackOutput? = null

    private var sampleRateHz: Int = 0
    private var channelCount: Int = 0
    private var dataStart: Long = 0
    private var dataSize: Long = 0

    private var markerA: Byte = DopPacker.MARKER_A
    private var samplesOutput: Long = 0
    private val pcmBuf = ByteArray(6 * 1024)

    @Throws(IOException::class)
    override fun sniff(input: ExtractorInput): Boolean {
        // Nhận file DSD khi method là DoP/Native (output DoP) HOẶC PCM (output PCM fallback).
        // Spec P3 7.3: DSD→PCM fallback — convert bằng software trong extractor.
        val method = DacSettings.currentDsdMethod
        if (method != DacSettings.DSD_METHOD_DOP &&
            method != DacSettings.DSD_METHOD_NATIVE &&
            method != DacSettings.DSD_METHOD_PCM) return false
        return sniffMagic(input)
    }

    /** True nếu đang ở chế độ PCM fallback (convert DSD→PCM thay vì pack DoP). */
    private fun isPcmMode(): Boolean =
        DacSettings.currentDsdMethod == DacSettings.DSD_METHOD_PCM

    override fun init(output: ExtractorOutput) {
        this.output = output
        trackOutput = output.track(0, C.TRACK_TYPE_AUDIO)
        output.endTracks()
    }

    @Throws(IOException::class)
    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (sampleRateHz == 0) {
            parseHeader(input)
            val outRate: Int
            if (isPcmMode()) {
                // PCM fallback: DSD→PCM bằng software, rate = DSD/32
                outRate = DsdToPcmConverter.pcmSampleRate(sampleRateHz)
            } else {
                // DoP: rate = DSD/16
                outRate = DopPacker.dopSampleRate(sampleRateHz)
            }
            val format = Format.Builder()
                .setSampleMimeType(MimeTypes.AUDIO_RAW)
                .setChannelCount(channelCount)
                .setSampleRate(outRate)
                .setPcmEncoding(C.ENCODING_PCM_24BIT)
                .build()
            trackOutput?.format(format)
            // Không seek được → dùng Unseekable (chuẩn Media3 cho stream live/raw)
            output?.seekMap(SeekMap.Unseekable(C.TIME_UNSET))
            input.skipFully((dataStart - input.position).toInt())
        }

        if (channelCount != 2) {
            throw IOException("DffExtractor v1 chỉ hỗ trợ stereo, file này có $channelCount kênh")
        }

        // DSDIFF multiplexed theo sample: [L0][R0][L1][R1]...
        val outRate: Int
        val pcmPos: Int
        val samplesThisBatch: Long
        if (isPcmMode()) {
            // PCM fallback: 8 bytes DSD multiplexed → de-multiplex → 1 PCM sample/kênh
            // [L0][R0][L1][R1][L2][R2][L3][R3] → L=[L0..L3], R=[R0..R3] → 6 bytes PCM stereo
            outRate = DsdToPcmConverter.pcmSampleRate(sampleRateHz)
            val maxPcmSamplesByBuf = pcmBuf.size / 6
            val dsdToRead = maxPcmSamplesByBuf * 8 // 8 bytes DSD → 1 PCM sample stereo
            val dsdBuf = ByteArray(dsdToRead)

            val read = input.read(dsdBuf, 0, dsdToRead)
            if (read == C.RESULT_END_OF_INPUT) return Extractor.RESULT_END_OF_INPUT
            if (read <= 0) return Extractor.RESULT_CONTINUE

            val fullGroups = read / 8 // mỗi group 8 bytes → 1 PCM sample stereo
            // De-multiplex: tách L và R
            val dsdL = ByteArray(fullGroups * 4)
            val dsdR = ByteArray(fullGroups * 4)
            for (g in 0 until fullGroups) {
                val base = g * 8
                // L: byte 0,2,4,6 của group; R: byte 1,3,5,7
                dsdL[g * 4] = dsdBuf[base]
                dsdL[g * 4 + 1] = dsdBuf[base + 2]
                dsdL[g * 4 + 2] = dsdBuf[base + 4]
                dsdL[g * 4 + 3] = dsdBuf[base + 6]
                dsdR[g * 4] = dsdBuf[base + 1]
                dsdR[g * 4 + 1] = dsdBuf[base + 3]
                dsdR[g * 4 + 2] = dsdBuf[base + 5]
                dsdR[g * 4 + 3] = dsdBuf[base + 7]
            }
            pcmPos = DsdToPcmConverter.convertStereo(
                dsdL, 0, dsdR, 0, fullGroups * 4, pcmBuf, 0
            )
            samplesThisBatch = fullGroups * 2L
        } else {
            // DoP: 1 frame stereo = 4 bytes DSD → 6 bytes PCM DoP
            outRate = DopPacker.dopSampleRate(sampleRateHz)
            val bytesPerFrame = 2 * channelCount // 4 bytes
            val framesPerRead = pcmBuf.size / 6
            val dsdToRead = framesPerRead * bytesPerFrame
            val dsdBuf = ByteArray(dsdToRead)

            val read = input.read(dsdBuf, 0, dsdToRead)
            if (read == C.RESULT_END_OF_INPUT) return Extractor.RESULT_END_OF_INPUT
            if (read <= 0) return Extractor.RESULT_CONTINUE

            val fullFrames = read / bytesPerFrame
            var pos = 0
            var dsdPos = 0
            // Marker luân phiên mỗi sample: L=05, R=FA, L=05, R=FA...
            // Số sample/frame chẵn (2) → giữ nguyên markerA giữa các frame.
            repeat(fullFrames) {
                val dsdL = byteArrayOf(dsdBuf[dsdPos], dsdBuf[dsdPos + 1])
                val dsdR = byteArrayOf(dsdBuf[dsdPos + 2], dsdBuf[dsdPos + 3])
                DopPacker.packStereoFrame(dsdL, dsdR, markerA, pcmBuf, pos)
                pos += 6
                dsdPos += bytesPerFrame
            }
            pcmPos = pos
            samplesThisBatch = fullFrames * 2L
        }

        val timeUs = samplesOutput * 1_000_000L / outRate
        samplesOutput += samplesThisBatch

        trackOutput?.sampleData(ParsableByteArray(pcmBuf, pcmPos), pcmPos)
        trackOutput?.sampleMetadata(
            timeUs, C.BUFFER_FLAG_KEY_FRAME, pcmPos, 0, null
        )
        return Extractor.RESULT_CONTINUE
    }

    override fun seek(position: Long, timeUs: Long) {
        // v1: không seek
    }

    override fun release() {
        // Không có resource cần giải phóng
    }

    @Throws(IOException::class)
    private fun parseHeader(input: ExtractorInput) {
        // Đọc FRM8 header (12 bytes)
        val frm8 = ByteArray(12)
        input.peekFully(frm8, 0, 12)
        var pb = ParsableByteArray(frm8)
        val magic = ByteArray(4)
        pb.readBytes(magic, 0, 4)
        require(magic.contentEquals(FRM8)) { "Không phải file DSDIFF" }
        pb.skipBytes(8) // chunkSize (BE)
        pb.readBytes(magic, 0, 4)
        require(magic.contentEquals(DSD_FORM)) { "Form type không phải DSD" }

        // Quét các chunk để tìm PROP/SND (FS, CHNL) và DSD (data)
        // Chunk đầu tiên bắt đầu ở offset 16 (sau FRM8 header 12 bytes + formType 4 bytes)
        var offset = 16L
        var propEnd = -1L
        while (true) {
            val chunkHeader = ByteArray(12)
            try {
                input.peekFully(chunkHeader, offset.toInt(), 12)
            } catch (_: IOException) {
                break
            }
            pb = ParsableByteArray(chunkHeader)
            val chunkId = ByteArray(4)
            pb.readBytes(chunkId, 0, 4)
            val chunkSize = pb.readLong() // big-endian
            if (chunkSize < 0 || chunkSize > Int.MAX_VALUE) break

            when {
                chunkId.contentEquals(PROP) -> {
                    // PROP chứa propType "SND " + các sub-chunk
                    parsePropSnd(input, offset + 12, chunkSize)
                    propEnd = offset + 12 + chunkSize
                }
                chunkId.contentEquals(DSD_DATA) -> {
                    dataStart = offset + 12
                    dataSize = chunkSize
                    break // đã đủ thông tin
                }
            }
            // Chunk size chẵn hóa (pad byte nếu lẻ)
            val paddedSize = if (chunkSize % 2 == 1L) chunkSize + 1 else chunkSize
            offset += 12 + paddedSize
            if (offset > 1024 * 1024) break // an toàn: không quét quá 1MB header
        }

        require(sampleRateHz > 0) { "Không tìm thấy sample rate (chunk FS)" }
        require(channelCount > 0) { "Không tìm thấy số kênh (chunk CHNL)" }
        require(dataSize > 0) { "Không tìm thấy DSD data" }
    }

    @Throws(IOException::class)
    private fun parsePropSnd(input: ExtractorInput, propDataOffset: Long, propSize: Long) {
        // 4 bytes đầu là propType "SND "
        val typeBuf = ByteArray(4)
        input.peekFully(typeBuf, 0, 4, propDataOffset.toInt())
        val pb0 = ParsableByteArray(typeBuf)
        val propType = ByteArray(4)
        pb0.readBytes(propType, 0, 4)
        require(propType.contentEquals(SND)) { "PROP type không phải SND" }

        var offset = propDataOffset + 4
        val end = propDataOffset + propSize
        while (offset < end) {
            val subHeader = ByteArray(12)
            try {
                input.peekFully(subHeader, 0, 12, offset.toInt())
            } catch (_: IOException) {
                break
            }
            val pb = ParsableByteArray(subHeader)
            val subId = ByteArray(4)
            pb.readBytes(subId, 0, 4)
            val subSize = pb.readLong() // big-endian
            if (subSize < 0 || subSize > Int.MAX_VALUE) break

            when {
                subId.contentEquals(FS) -> {
                    val rateBuf = ByteArray(4)
                    input.peekFully(rateBuf, 0, 4, (offset + 12).toInt())
                    sampleRateHz = ParsableByteArray(rateBuf).readInt() // BE
                }
                subId.contentEquals(CHNL) -> {
                    val chBuf = ByteArray(2)
                    input.peekFully(chBuf, 0, 2, (offset + 12).toInt())
                    channelCount = ParsableByteArray(chBuf).readUnsignedShort()
                }
                // CMPR: bỏ qua (v1 chỉ hỗ trợ DSD raw không nén)
            }
            val paddedSize = if (subSize % 2 == 1L) subSize + 1 else subSize
            offset += 12 + paddedSize
        }
    }
}

// Extension để peek với offset (ExtractorInput.peekFully không có offset param)
@Throws(IOException::class)
private fun ExtractorInput.peekFully(
    target: ByteArray, offset: Int, length: Int, peekOffset: Int
) {
    // Dùng PositionHolder để peek tại vị trí tuyệt đối
    // Cách đơn giản: resetPeekPosition + advancePeekPosition không hỗ trợ offset tuyệt đối,
    // nên ta dùng peekFully tuần tự. Với header nhỏ (<1MB) thì đọc từ đầu là OK.
    // NOTE: hàm này giả định peekOffset >= vị trí peek hiện tại.
    val currentPos = this.peekPosition
    if (peekOffset < currentPos) {
        this.resetPeekPosition()
    }
    this.advancePeekPosition((peekOffset - this.peekPosition).toInt())
    this.peekFully(target, offset, length)
}
