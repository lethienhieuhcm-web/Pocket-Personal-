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
 * DsfExtractor — đọc file DSF (DSD Stream File của Sony) và output PCM
 * chứa DoP (DSD over PCM) để phát qua USB DAC.
 *
 * Format DSF (spec công khai của Sony):
 * - Chunk "DSD " (28 bytes): magic(4) + chunkSize(8 LE) + totalSize(8 LE) + metaPtr(8 LE)
 * - Chunk "fmt " (52 bytes): magic(4) + chunkSize(8) + version(4) + formatId(4)
 *   + channelType(4) + channelNum(4) + sampleFreq(4 LE) + bitsPerSample(4)
 *   + sampleCount(8 LE) + blockSize(4) + reserved(4)
 * - Chunk "data": magic(4) + chunkSize(8 LE) + DSD raw (interleave theo block/channel)
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
    private var dataStart: Long = 0        // offset bắt đầu DSD raw
    private var dataEnd: Long = 0          // offset kết thúc
    private var totalDsdBytes: Long = 0

    private var markerA: Byte = DopPacker.MARKER_A
    private var samplesOutput: Long = 0 // đếm sample PCM đã output (để tính timeUs)
    private val pcmBuf = ByteArray(6 * 1024) // buffer output: 1024 frame stereo

    @Throws(IOException::class)
    override fun sniff(input: ExtractorInput): Boolean = sniffMagic(input)

    override fun init(output: ExtractorOutput) {
        this.output = output
        trackOutput = output.track(0, C.TRACK_TYPE_AUDIO)
        output.endTracks()
    }

    @Throws(IOException::class)
    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (sampleRateHz == 0) {
            parseHeader(input)
            val dopRate = DopPacker.dopSampleRate(sampleRateHz)
            val format = Format.Builder()
                .setSampleMimeType(MimeTypes.AUDIO_RAW)
                .setChannelCount(channelCount)
                .setSampleRate(dopRate)
                .setPcmEncoding(C.ENCODING_PCM_24BIT)
                .build()
            trackOutput?.format(format)
            output?.seekMap(object : SeekMap {
                override fun isSeekable() = false
                override fun getDurationUs() = C.TIME_UNSET
                override fun getSeekPoints(timeUs: Long) =
                    SeekMap.SeekPoints(SeekMap.SeekPoint(0, dataStart))
            })
            input.skipFully((dataStart - input.position).toInt())
        }

        // Đọc DSD raw theo frame stereo (2 byte/kênh), pack thành DoP
        val bytesPerFrame = 2 * channelCount // 2 byte DSD mỗi kênh
        val framesPerRead = pcmBuf.size / 6  // 6 bytes PCM mỗi frame stereo
        val dsdToRead = framesPerRead * bytesPerFrame
        val dsdBuf = ByteArray(dsdToRead)

        val read = input.read(dsdBuf, 0, dsdToRead)
        if (read == C.RESULT_END_OF_INPUT) return Extractor.RESULT_END_OF_INPUT
        if (read <= 0) return Extractor.RESULT_CONTINUE

        // Chỉ hỗ trợ stereo (2 kênh) ở v1 — mono/DSD khác báo lỗi rõ
        if (channelCount != 2) {
            throw IOException("DsfExtractor v1 chỉ hỗ trợ stereo, file này có $channelCount kênh")
        }

        val fullFrames = read / bytesPerFrame
        var pcmPos = 0
        var dsdPos = 0
        // Mỗi frame stereo = 2 sample PCM. Marker luân phiên mỗi SAMPLE theo
        // chuẩn DoP v1.1: L=05, R=FA, L=05, R=FA... Vì số sample/frame là chẵn (2),
        // frame tiếp theo bắt đầu lại với cùng marker → KHÔNG đổi markerA giữa frame.
        // (Bug đã fix 17/10: đổi marker mỗi frame cho ra chuỗi 05,FA,FA,05... sai chuẩn.)
        repeat(fullFrames) {
            val dsdL = byteArrayOf(dsdBuf[dsdPos], dsdBuf[dsdPos + 1])
            val dsdR = byteArrayOf(dsdBuf[dsdPos + 2], dsdBuf[dsdPos + 3])
            DopPacker.packStereoFrame(dsdL, dsdR, markerA, pcmBuf, pcmPos)
            pcmPos += 6
            dsdPos += bytesPerFrame
        }

        val dopRate = DopPacker.dopSampleRate(sampleRateHz)
        // timeUs tăng dần: mỗi frame = 2 sample
        val timeUs = samplesOutput * 1_000_000L / dopRate
        samplesOutput += fullFrames * 2

        trackOutput?.sampleData(ParsableByteArray(pcmBuf, pcmPos), pcmPos)
        trackOutput?.sampleMetadata(
            timeUs, C.BUFFER_FLAG_KEY_FRAME, pcmPos, 0, null
        )
        return Extractor.RESULT_CONTINUE
    }

    override fun seek(position: Long, timeUs: Long) {
        // v1: không seek (SeekMap báo không seekable)
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
        pb.skipBytes(8) // sampleCount
        pb.skipBytes(4) // blockSize
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
