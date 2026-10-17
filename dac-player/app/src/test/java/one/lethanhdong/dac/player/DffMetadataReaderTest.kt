package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Unit test cho DffMetadataReader.
 * Logic parse DIIN/DIAR/DITI đã verify bằng Python (tạo DFF giả lập theo spec Philips DSDIFF 1.5).
 */
class DffMetadataReaderTest {

    private fun buildDff(artist: String?, title: String?): File {
        val f = File.createTempFile("test", ".dff")
        val out = mutableListOf<Byte>()

        fun writeChunk(ckId: String, data: ByteArray) {
            out.addAll(ckId.toByteArray(Charsets.US_ASCII).toList())
            val sizeBytes = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
                .putLong(data.size.toLong()).array()
            out.addAll(sizeBytes.toList())
            out.addAll(data.toList())
            if (data.size % 2 == 1) out.add(0) // pad byte
        }

        fun textChunk(ckId: String, text: String): ByteArray {
            val textBytes = text.toByteArray(Charsets.US_ASCII)
            val buf = ByteBuffer.allocate(4 + textBytes.size).order(ByteOrder.BIG_ENDIAN)
            buf.putInt(textBytes.size)
            buf.put(textBytes)
            return buf.array()
        }

        // FRM8 header: 'FRM8' + size (8 bytes) + 'DSD '
        out.addAll("FRM8".toByteArray(Charsets.US_ASCII).toList())
        val frm8SizePos = out.size
        out.addAll(ByteArray(8).toList()) // placeholder
        out.addAll("DSD ".toByteArray(Charsets.US_ASCII).toList())

        // DIIN chunk với DIAR/DITI
        val diinData = mutableListOf<Byte>()
        fun writeSubChunk(ckId: String, data: ByteArray) {
            diinData.addAll(ckId.toByteArray(Charsets.US_ASCII).toList())
            val sizeBytes = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
                .putLong(data.size.toLong()).array()
            diinData.addAll(sizeBytes.toList())
            diinData.addAll(data.toList())
            if (data.size % 2 == 1) diinData.add(0)
        }
        if (artist != null) writeSubChunk("DIAR", textChunk("DIAR", artist))
        if (title != null) writeSubChunk("DITI", textChunk("DITI", title))

        val diinBytes = diinData.toByteArray()
        val diinChunk = mutableListOf<Byte>()
        diinChunk.addAll("DIIN".toByteArray(Charsets.US_ASCII).toList())
        diinChunk.addAll(ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
            .putLong(diinBytes.size.toLong()).array().toList())
        diinChunk.addAll(diinBytes.toList())
        out.addAll(diinChunk)

        // Cập nhật FRM8 size
        val totalSize = out.size - 12
        val sizeBytes = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
            .putLong(totalSize.toLong()).array()
        for (i in 0 until 8) out[frm8SizePos + i] = sizeBytes[i]

        f.writeBytes(out.toByteArray())
        return f
    }

    @Test
    fun read_dffWithArtistAndTitle_returnsMetadata() {
        val f = buildDff("Test Artist", "Test Title")
        try {
            val meta = DffMetadataReader.read(f)
            assertNotNull(meta)
            assertEquals("Test Artist", meta!!.artist)
            assertEquals("Test Title", meta.title)
            assertNull(meta.album) // DFF không có album
        } finally {
            f.delete()
        }
    }

    @Test
    fun read_dffWithOddLengthText_handlesPadByte() {
        // "ABC" = 3 bytes (lẻ) → có pad byte
        val f = buildDff("ABC", "XY")
        try {
            val meta = DffMetadataReader.read(f)
            assertNotNull(meta)
            assertEquals("ABC", meta!!.artist)
            assertEquals("XY", meta.title)
        } finally {
            f.delete()
        }
    }

    @Test
    fun read_dffWithoutDiin_returnsNull() {
        val f = File.createTempFile("test", ".dff")
        try {
            // FRM8 header tối thiểu, không có DIIN
            val header = "FRM8".toByteArray(Charsets.US_ASCII) +
                ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(4).array() +
                "DSD ".toByteArray(Charsets.US_ASCII)
            f.writeBytes(header)
            assertNull(DffMetadataReader.read(f))
        } finally {
            f.delete()
        }
    }

    @Test
    fun read_nonDffFile_returnsNull() {
        val f = File.createTempFile("test", ".flac")
        try {
            assertNull(DffMetadataReader.read(f))
        } finally {
            f.delete()
        }
    }

    @Test
    fun read_nonexistentFile_returnsNull() {
        assertNull(DffMetadataReader.read(File("/nonexistent/test.dff")))
    }
}
