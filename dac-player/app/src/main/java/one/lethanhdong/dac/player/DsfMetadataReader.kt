package one.lethanhdong.dac.player

import java.io.File
import java.io.RandomAccessFile

/**
 * DsfMetadataReader — đọc metadata (title/artist/album) từ file DSF.
 *
 * Theo spec DSF của Sony: DSD chunk header (28 bytes) có field metaPtr (8 bytes,
 * little-endian) ở offset 20. Nếu metaPtr != 0, nó trỏ tới ID3v2 tag.
 *
 * ID3v2 header (10 bytes):
 * - "ID3" (3 bytes)
 * - version major/minor (2 bytes)
 * - flags (1 byte)
 * - size (4 bytes, syncsafe: mỗi byte chỉ dùng 7 bit)
 *
 * Sau header là các frame: FrameID (4 bytes) + size (4 bytes) + flags (2 bytes) + data.
 * - TIT2: title
 * - TPE1: artist
 * - TALB: album
 *
 * Text encoding: byte đầu của data (0=ISO-8859-1, 1=UTF-16, 2=UTF-16BE, 3=UTF-8).
 *
 * Không dùng MediaMetadataRetriever vì Android không hỗ trợ DSF (Stagefright
 * không có DSF parser) — tự parse ID3v2 theo spec, không bịa.
 */
object DsfMetadataReader {

    data class DsdMetadata(
        val title: String?,
        val artist: String?,
        val album: String?,
    )

    /**
     * Đọc metadata từ file DSF local. Trả về null nếu không có metadata.
     */
    fun read(file: File): DsdMetadata? {
        if (!file.exists() || !file.name.lowercase().endsWith(".dsf")) return null
        return try {
            RandomAccessFile(file, "r").use { raf ->
                // Đọc metaPtr từ DSD chunk header (offset 20, 8 bytes LE)
                if (raf.length() < 28) return null
                raf.seek(20)
                val metaPtr = readLittleEndianLong(raf)
                if (metaPtr <= 0 || metaPtr >= raf.length()) return null

                // Parse ID3v2 tại metaPtr
                parseId3v2(raf, metaPtr)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseId3v2(raf: RandomAccessFile, offset: Long): DsdMetadata? {
        raf.seek(offset)
        val header = ByteArray(10)
        if (raf.read(header) != 10) return null
        if (!(header[0] == 'I'.code.toByte() && header[1] == 'D'.code.toByte() && header[2] == '3'.code.toByte())) {
            return null
        }
        // Size là syncsafe integer (4 bytes, mỗi byte 7 bit)
        val tagSize = ((header[6].toInt() and 0x7F) shl 21) or
                      ((header[7].toInt() and 0x7F) shl 14) or
                      ((header[8].toInt() and 0x7F) shl 7) or
                      (header[9].toInt() and 0x7F)

        var title: String? = null
        var artist: String? = null
        var album: String? = null

        var pos = offset + 10
        val end = offset + 10 + tagSize
        while (pos < end - 10) {
            raf.seek(pos)
            val frameHeader = ByteArray(10)
            if (raf.read(frameHeader) != 10) break

            val frameId = String(frameHeader, 0, 4, Charsets.ISO_8859_1)
            // Frame size (ID3v2.3: 4 bytes big-endian; ID3v2.4: syncsafe)
            // Đọc theo v2.3 (phổ biến nhất cho DSF)
            val frameSize = ((frameHeader[4].toInt() and 0xFF) shl 24) or
                           ((frameHeader[5].toInt() and 0xFF) shl 16) or
                           ((frameHeader[6].toInt() and 0xFF) shl 8) or
                           (frameHeader[7].toInt() and 0xFF)
            if (frameSize <= 0 || frameSize > end - pos) break

            val data = ByteArray(frameSize)
            raf.read(data)
            val text = decodeText(data)

            when (frameId) {
                "TIT2" -> if (title == null) title = text
                "TPE1" -> if (artist == null) artist = text
                "TALB" -> if (album == null) album = text
            }

            pos += 10 + frameSize
            if (title != null && artist != null && album != null) break
        }

        if (title == null && artist == null && album == null) return null
        return DsdMetadata(title, artist, album)
    }

    private fun decodeText(data: ByteArray): String? {
        if (data.isEmpty()) return null
        return try {
            val encoding = data[0].toInt() and 0xFF
            val textBytes = data.copyOfRange(1, data.size)
            // Loại bỏ null terminator
            val endIndex = textBytes.indexOf(0).takeIf { it >= 0 } ?: textBytes.size
            val clean = textBytes.copyOfRange(0, endIndex)
            when (encoding) {
                0 -> String(clean, Charsets.ISO_8859_1)
                1 -> String(clean, Charsets.UTF_16) // có BOM
                2 -> String(clean, Charsets.UTF_16BE)
                3 -> String(clean, Charsets.UTF_8)
                else -> String(clean, Charsets.ISO_8859_1)
            }.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    private fun readLittleEndianLong(raf: RandomAccessFile): Long {
        val bytes = ByteArray(8)
        raf.readFully(bytes)
        var result = 0L
        for (i in 7 downTo 0) {
            result = (result shl 8) or (bytes[i].toLong() and 0xFF)
        }
        return result
    }
}
