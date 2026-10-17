package one.lethanhdong.dac.player

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * DffMetadataReader — đọc metadata (title/artist) từ file DFF (DSDIFF).
 *
 * Theo spec Philips DSDIFF 1.5:
 * - §3.7: DIIN (Edited Master Information Chunk) là container chứa các sub-chunk
 * - §3.7.3: Artist Chunk, ckID='DIAR', count (ulong 4 bytes BE) + artistText[]
 * - §3.7.4: Title Chunk, ckID='DITI', count (ulong 4 bytes BE) + titleText[]
 * - §2.2: toàn bộ DSDIFF là BIG ENDIAN
 * - Text là ASCII (0x20-0x7E), pad 1 byte nếu độ dài lẻ (pad không tính trong count)
 * - DIIN/DIAR/DITI đều optional, tối đa 1 lần
 *
 * DFF spec không có album → album luôn null.
 *
 * Không dùng MediaMetadataRetriever vì Android không hỗ trợ DFF — tự parse theo spec.
 */
object DffMetadataReader {

    private val FRM8 = "FRM8".toByteArray(Charsets.US_ASCII)
    private val DIIN = "DIIN".toByteArray(Charsets.US_ASCII)
    private val DIAR = "DIAR".toByteArray(Charsets.US_ASCII)
    private val DITI = "DITI".toByteArray(Charsets.US_ASCII)

    /**
     * Đọc metadata từ file DFF local. Trả về null nếu không có metadata.
     */
    fun read(file: File): DsfMetadataReader.DsdMetadata? {
        if (!file.exists() || !file.name.lowercase().endsWith(".dff")) return null
        return try {
            RandomAccessFile(file, "r").use { raf ->
                if (raf.length() < 16) return null

                // Kiểm tra FRM8 header
                val magic = ByteArray(4)
                raf.seek(0)
                if (raf.read(magic) != 4 || !magic.contentEquals(FRM8)) return null

                // Quét các chunk tìm DIIN (bắt đầu ở offset 16)
                val diinOffset = findChunk(raf, DIIN, 16L) ?: return null
                parseDiin(raf, diinOffset)
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Quét các chunk từ [startOffset] để tìm chunk có ckID khớp.
     * Trả về offset của data chunk (sau header 12 bytes), hoặc null.
     */
    private fun findChunk(raf: RandomAccessFile, targetId: ByteArray, startOffset: Long): Long? {
        var offset = startOffset
        val fileLen = raf.length()
        val header = ByteArray(12)

        while (offset + 12 <= fileLen) {
            raf.seek(offset)
            if (raf.read(header) != 12) break

            val ckId = header.copyOfRange(0, 4)
            val ckSize = ByteBuffer.wrap(header, 4, 8)
                .order(ByteOrder.BIG_ENDIAN).long

            if (ckSize < 0 || offset + 12 + ckSize > fileLen) break

            if (ckId.contentEquals(targetId)) {
                return offset + 12 // data bắt đầu sau header
            }

            // Pad byte nếu size lẻ
            val paddedSize = if (ckSize % 2 == 1L) ckSize + 1 else ckSize
            offset += 12 + paddedSize

            // An toàn: không quét quá 1MB
            if (offset - startOffset > 1024 * 1024) break
        }
        return null
    }

    /**
     * Parse DIIN chunk: tìm DIAR (artist) và DITI (title) trong các sub-chunk.
     */
    private fun parseDiin(raf: RandomAccessFile, diinDataOffset: Long): DsfMetadataReader.DsdMetadata? {
        // Đọc ckDataSize của DIIN để biết giới hạn
        raf.seek(diinDataOffset - 8)
        val sizeBuf = ByteArray(8)
        if (raf.read(sizeBuf) != 8) return null
        val diinSize = ByteBuffer.wrap(sizeBuf).order(ByteOrder.BIG_ENDIAN).long
        if (diinSize <= 0) return null

        val diinEnd = diinDataOffset + diinSize
        var offset = diinDataOffset
        var artist: String? = null
        var title: String? = null
        val header = ByteArray(12)

        while (offset + 12 <= diinEnd && offset + 12 <= raf.length()) {
            raf.seek(offset)
            if (raf.read(header) != 12) break

            val ckId = header.copyOfRange(0, 4)
            val ckSize = ByteBuffer.wrap(header, 4, 8)
                .order(ByteOrder.BIG_ENDIAN).long

            if (ckSize < 0 || offset + 12 + ckSize > raf.length()) break

            when {
                ckId.contentEquals(DIAR) -> {
                    artist = readTextChunk(raf, offset + 12, ckSize)
                }
                ckId.contentEquals(DITI) -> {
                    title = readTextChunk(raf, offset + 12, ckSize)
                }
            }

            val paddedSize = if (ckSize % 2 == 1L) ckSize + 1 else ckSize
            offset += 12 + paddedSize
        }

        if (artist == null && title == null) return null
        return DsfMetadataReader.DsdMetadata(title = title, artist = artist, album = null)
    }

    /**
     * Đọc text từ DIAR/DITI chunk: count (4 bytes BE) + text bytes.
     * Trả về null nếu count không hợp lệ.
     */
    private fun readTextChunk(raf: RandomAccessFile, dataOffset: Long, ckSize: Long): String? {
        if (ckSize < 4) return null
        raf.seek(dataOffset)
        val countBuf = ByteArray(4)
        if (raf.read(countBuf) != 4) return null
        val count = ByteBuffer.wrap(countBuf).order(ByteOrder.BIG_ENDIAN).int

        if (count < 0 || count > ckSize - 4) return null
        if (count == 0) return ""

        val textBytes = ByteArray(count)
        if (raf.read(textBytes) != count) return null

        // DSDIFF text là ASCII (0x20-0x7E); dùng US_ASCII, thay ký tự lạ bằng ?
        return String(textBytes, Charsets.US_ASCII).trim()
    }
}
