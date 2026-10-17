package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Unit test cho DsfMetadataReader.
 * Logic parse ID3v2 đã verify bằng Python (tạo DSF giả lập).
 */
class DsfMetadataReaderTest {

    @Test
    fun read_nonDsfFile_returnsNull() {
        val f = File.createTempFile("test", ".flac")
        try {
            assertNull(DsfMetadataReader.read(f))
        } finally {
            f.delete()
        }
    }

    @Test
    fun read_nonexistentFile_returnsNull() {
        assertNull(DsfMetadataReader.read(File("/nonexistent/test.dsf")))
    }

    @Test
    fun read_dsfWithoutMetadata_returnsNull() {
        // DSF không có metaPtr (metaPtr=0)
        val f = File.createTempFile("test", ".dsf")
        try {
            // DSD header 28 bytes với metaPtr=0
            val header = ByteArray(28)
            header[0] = 'D'.code.toByte()
            header[1] = 'S'.code.toByte()
            header[2] = 'F'.code.toByte()
            header[3] = ' '.code.toByte()
            f.writeBytes(header)
            assertNull(DsfMetadataReader.read(f))
        } finally {
            f.delete()
        }
    }
}
