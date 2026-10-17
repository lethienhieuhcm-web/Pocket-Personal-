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
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import java.io.IOException

/**
 * DsfExtractor — đọc file DSF (DSD Stream File của Sony) và output PCM
 * chứa DoP (DSD over PCM) để phát qua USB DAC.
 *
 * Format DSF (spec công khai của Sony):
 * - Chunk "DSD " (28 bytes): magic(4) + chunkSize(8 LE) + totalSize(8 LE) + metaPtr(8 LE)
 * - Chunk "fmt " (52 bytes): magic(4) + chunkSize(8) + version(4) + formatId(4)
 *   + channelType(4) + channelNum(4) + sampleFreq(4 LE) + bitsPerSample(4)
 *   + sampleCount(8 LE) + blockSizePerChannel(4 LE) + reserved(4)
 * - Chunk "data": magic(4) + chunkSize(8 LE) + DSD raw
 *
 * QUAN TRỌNG — DSD data trong DSF lưu theo BLOCK, không xen kẽ từng sample:
 *   [L block 4096 bytes][R block 4096 bytes][L block][R block]...
 *   (blockSizePerChannel đọc từ fmt chunk, thường là 4096)
 * Code phải de-interleave block trước khi pack DoP.
 *
 * Output: PCM 24-bit little-endian, sample rate = DSD rate / 16 (DoP),
 * mỗi sample đã pack marker 0x05/0xFA qua DopPacker.
 *
 * Spec P3 7.1: DSD DoP app-level v1.
 */
@UnstableApi
class DsfExtractor : Extractor {

    companion object {
        private val DSF_MAGIC = byteArrayOf('D'.code.toByte(), 'S'.code.toByte(), 'F'.code.toByte(), ' '.code.toByte())
        private val FMT_MAGIC = byteArrayOf('f'.code.toByte(), 'm'.code.toByte(), 't'.code.toByte(), ' '.code.toByte())
        private val DATA_MAGIC = byteArrayOf('d'.code.toByte(), 'a'.code.toByte(), 't'.code.toByte(), 'a'.code.toByte())

        /** DSD header có thể đọc để sniff (28 bytes đầu). */
        const val SNIFF_SIZE = 28

        fun sniffMagic(input: ExtractorInput): Boolean {
            val buf = ByteArray(4)
            return try {
                input.peekFully(buf, 0, 4)
                buf.contentEquals(DSF_MAGIC)
            } catch (_: IOException) {
                false
            }
        }
    }

    private var output: ExtractorOutput? = null
    private var trackOutput: TrackOutput? = null

    private var sampleRateHz: Int = 0      // DSD rate gốc (vd 2822400)
    private var channelCount: Int = 0
    private var sampleCount: Long = 0    // tổng số DSD sample/kênh (để tính duration + seek)
    private var blockSizePerChannel: Int = 4096 // đọc từ fmt chunk
    private var dataStart: Long = 0        // offset bắt đầu DSD raw
    private var dataEnd: Long = 0          // offset kết thúc
    private var totalDsdBytes: Long = 0

    // Buffer de-interleave: 1 block group = blockSize * channelCount bytes
    // Layout trên đĩa: [L block][R block] → tách thành L stream, R stream
    private var blockBuf: ByteArray = ByteArray(0)
    private var blockBufPos: Int = 0  // vị trí đã pack trong blockBuf
    private var blockBufValid: Int = 0 // số byte hợp lệ trong blockBuf

    private var markerA: Byte = DopPacker.MARKER_A
    private var samplesOutput: Long = 0 // đếm sample PCM đã output (để tính timeUs)
    private val pcmBuf = ByteArray(6 * 1024) // buffer output: 1024 frame stereo

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

    /** SeekMap cho DSF: tính byte position từ timeUs (block-aligned). */
    private inner class DsfSeekMap : SeekMap {
        override fun isSeekable(): Boolean = true
        override fun getDurationUs(): Long =
            if (sampleRateHz > 0 && sampleCount > 0)
                sampleCount * 1_000_000L / sampleRateHz
            else C.TIME_UNSET

        override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
            val durationUs = getDurationUs()
            val clampedUs = timeUs.coerceIn(0, durationUs)
            // Sample index → block index (block-aligned để đơn giản)
            val targetSample = clampedUs * sampleRateHz / 1_000_000L
            val samplesPerBlock = blockSizePerChannel * 8L
            val blockIndex = (targetSample / samplesPerBlock).coerceIn(
                0, (sampleCount / samplesPerBlock)
            )
            val filePos = dataStart + blockIndex * blockSizePerChannel * channelCount
            val seekPoint = SeekPoint(clampedUs, filePos)
            return SeekMap.SeekPoints(seekPoint, seekPoint)
        }
    }

    @Throws(IOException::class)
    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (sampleRateHz == 0) {
            parseHeader(input)
            val outRate: Int
            val pcmEncoding: Int
            if (isPcmMode()) {
                // PCM fallback: DSD→PCM bằng software, rate = DSD/32
                outRate = DsdToPcmConverter.pcmSampleRate(sampleRateHz)
                pcmEncoding = C.ENCODING_PCM_24BIT
            } else {
                // DoP: rate = DSD/16, PCM 24-bit chứa marker DoP
                outRate = DopPacker.dopSampleRate(sampleRateHz)
                pcmEncoding = C.ENCODING_PCM_24BIT
            }
            val format = Format.Builder()
                .setSampleMimeType(MimeTypes.AUDIO_RAW)
                .setChannelCount(channelCount)
                .setSampleRate(outRate)
                .setPcmEncoding(pcmEncoding)
                .build()
            trackOutput?.format(format)
            // Seek được: dùng DsfSeekMap (block-aligned)
            output?.seekMap(DsfSeekMap())
            input.skipFully((dataStart - input.position).toInt())
        }

        // Chỉ hỗ trợ stereo (2 kênh) ở v1 — mono/DSD khác báo lỗi rõ
        if (channelCount != 2) {
            throw IOException("DsfExtractor v1 chỉ hỗ trợ stereo, file này có $channelCount kênh")
        }

        // Đọc 1 block group: [L blockSize bytes][R blockSize bytes]
        val blockGroupSize = blockSizePerChannel * channelCount
        if (blockBuf.size != blockGroupSize) {
            blockBuf = ByteArray(blockGroupSize)
            blockBufPos = 0
            blockBufValid = 0
        }

        // Nạp đầy block group (có thể cần nhiều lần read)
        // blockBufPos: số byte đã xử lý PER CHANNEL (0..blockSizePerChannel)
        // Khi đạt blockSizePerChannel → đã hết 1 block group, đọc group tiếp
        if (blockBufPos >= blockSizePerChannel) {
            blockBufPos = 0
            blockBufValid = 0
        }
        if (blockBufValid == 0) {
            var filled = 0
            while (filled < blockGroupSize) {
                val r = input.read(blockBuf, filled, blockGroupSize - filled)
                if (r == C.RESULT_END_OF_INPUT) {
                    return if (filled == 0) Extractor.RESULT_END_OF_INPUT
                           else Extractor.RESULT_CONTINUE
                }
                if (r <= 0) break
                filled += r
            }
            if (filled == 0) return Extractor.RESULT_CONTINUE
            blockBufValid = filled
            blockBufPos = 0
        }

        // De-interleave block: L = [0, blockSize), R = [blockSize, 2*blockSize)
        // blockBufPos < blockSizePerChannel luôn (đã reset ở trên)
        val bytesLeftInBlock = blockSizePerChannel - blockBufPos

        val outRate: Int
        val pcmPos: Int
        val samplesThisBatch: Long
        if (isPcmMode()) {
            // PCM fallback: convert DSD→PCM bằng software
            // 4 bytes DSD (32 bits) → 1 PCM sample/kênh → 6 bytes stereo
            outRate = DsdToPcmConverter.pcmSampleRate(sampleRateHz)
            val maxBytesByBuf = (pcmBuf.size / 6) * 4 // số byte DSD tối đa pack được
            val dsdBytesToConvert = minOf(maxBytesByBuf, bytesLeftInBlock)
                .let { it - (it % 4) } // làm tròn xuống bội số của 4
            if (dsdBytesToConvert <= 0) {
                blockBufPos = blockBufValid // hết block, đọc block tiếp
                return Extractor.RESULT_CONTINUE
            }
            // Tách L/R từ blockBuf (de-interleave)
            val lStart = blockBufPos
            val rStart = blockBufPos + blockSizePerChannel
            pcmPos = DsdToPcmConverter.convertStereo(
                blockBuf, lStart,
                blockBuf, rStart,
                dsdBytesToConvert,
                pcmBuf, 0
            )
            blockBufPos += dsdBytesToConvert
            // Số sample PCM đã output (stereo: mỗi sample = 2 kênh)
            samplesThisBatch = (dsdBytesToConvert * 8L / DsdToPcmConverter.DECIMATION) * 2
        } else {
            // DoP: pack từng cặp byte thành frame DoP stereo
            outRate = DopPacker.dopSampleRate(sampleRateHz)
            val maxFramesByBuf = pcmBuf.size / 6
            val maxFramesByBlock = bytesLeftInBlock / 2 // 2 byte DSD = 1 sample DoP
            val framesToPack = minOf(maxFramesByBuf, maxFramesByBlock)

            var pos = 0
            repeat(framesToPack) { i ->
                val lOff = blockBufPos + i * 2
                val rOff = blockBufPos + blockSizePerChannel + i * 2
                val dsdL = byteArrayOf(blockBuf[lOff], blockBuf[lOff + 1])
                val dsdR = byteArrayOf(blockBuf[rOff], blockBuf[rOff + 1])
                DopPacker.packStereoFrame(dsdL, dsdR, markerA, pcmBuf, pos)
                pos += 6
            }
            blockBufPos += framesToPack * 2
            pcmPos = pos
            samplesThisBatch = framesToPack * 2L
        }

        // timeUs tăng dần theo số sample đã output
        val timeUs = samplesOutput * 1_000_000L / outRate
        samplesOutput += samplesThisBatch

        trackOutput?.sampleData(ParsableByteArray(pcmBuf, pcmPos), pcmPos)
        trackOutput?.sampleMetadata(
            timeUs, C.BUFFER_FLAG_KEY_FRAME, pcmPos, 0, null
        )
        return Extractor.RESULT_CONTINUE
    }

    override fun seek(position: Long, timeUs: Long) {
        // Reset buffer state để đọc từ vị trí mới
        blockBufPos = 0
        blockBufValid = 0
        // Reset DoP marker để tránh lệch phase sau seek
        markerA = DopPacker.MARKER_A
        // samplesOutput sẽ được tính lại từ timeUs ở lần read tiếp theo
    }

    override fun release() {
        // Không có resource cần giải phóng
    }

    @Throws(IOException::class)
    private fun parseHeader(input: ExtractorInput) {
        val header = ByteArray(28 + 52)
        input.peekFully(header, 0, header.size)
        val pb = ParsableByteArray(header)

        // Chunk "DSD "
        val magic = ByteArray(4)
        pb.readBytes(magic, 0, 4)
        require(magic.contentEquals(DSF_MAGIC)) { "Không phải file DSF" }
        pb.skipBytes(8) // chunkSize
        pb.skipBytes(8) // totalSize
        pb.skipBytes(8) // metaPtr

        // Chunk "fmt " — TẤT CẢ số nguyên trong DSF là little-endian
        // (ParsableByteArray.readInt() mặc định big-endian → phải dùng readLittleEndianInt)
        pb.readBytes(magic, 0, 4)
        require(magic.contentEquals(FMT_MAGIC)) { "Thiếu chunk fmt" }
        pb.skipBytes(8) // chunkSize
        pb.skipBytes(4) // version
        val formatId = pb.readLittleEndianInt()
        require(formatId == 0) { "Chỉ hỗ trợ DSD raw (formatId=0), gặp $formatId" }
        pb.skipBytes(4) // channelType
        channelCount = pb.readLittleEndianInt()
        sampleRateHz = pb.readLittleEndianInt()
        val bitsPerSample = pb.readLittleEndianInt()
        require(bitsPerSample == 1 || bitsPerSample == 8) {
            "bitsPerSample không hỗ trợ: $bitsPerSample"
        }
        sampleCount = pb.readLittleEndianLong() // tổng DSD sample/kênh (để seek)
        blockSizePerChannel = pb.readLittleEndianInt()
        require(blockSizePerChannel > 0) { "blockSizePerChannel không hợp lệ: $blockSizePerChannel" }
        pb.skipBytes(4) // reserved

        // Tìm chunk "data" (ngay sau fmt trong file chuẩn, offset 80 = 28+52)
        val dataHeader = ByteArray(12)
        input.peekFully(dataHeader, 80, 12)
        val dpb = ParsableByteArray(dataHeader)
        dpb.readBytes(magic, 0, 4)
        require(magic.contentEquals(DATA_MAGIC)) { "Thiếu chunk data" }
        val dataSize = dpb.readLittleEndianLong()

        dataStart = 80 + 12
        dataEnd = dataStart + dataSize
        totalDsdBytes = dataSize
    }
}
