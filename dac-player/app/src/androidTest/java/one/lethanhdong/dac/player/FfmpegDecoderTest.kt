package one.lethanhdong.dac.player

import androidx.media3.common.MimeTypes
import androidx.media3.decoder.ffmpeg.FfmpegLibrary
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 1.5: guard chống regression "AAR ship nhưng không load" (bẫy 1.9.0/1.9.3:
 * build xong vẫn ffmpeg=false mà không báo lỗi).
 * - isAvailable() = libffmpegJNI.so đã load thật (không chỉ có mặt trong APK).
 * - supportsFormat() = build FFmpeg chứa đúng decoder (không chỉ load được lib).
 * Danh sách mime khớp map getCodecName() trong FfmpegLibrary.java ở tag 1.9.3
 * (đã đọc source thật): mỗi mime dưới đây map tới 1 decoder trong list build
 * (flac alac mp3 aac opus vorbis pcm_mulaw pcm_alaw ac3 eac3 dca mlp truehd).
 * KHÔNG test AMR/H264 — build không enable amrnb/amrwb/h264/hevc.
 */
@RunWith(AndroidJUnit4::class)
class FfmpegDecoderTest {

    @Test
    fun ffmpegLibraryIsAvailable() {
        assertTrue(
            "libffmpegJNI.so did not load — AAR shipped but not loaded",
            FfmpegLibrary.isAvailable()
        )
    }

    @Test
    fun ffmpegSupportsRequiredFormats() {
        assertTrue("libffmpegJNI.so did not load", FfmpegLibrary.isAvailable())
        val required = listOf(
            MimeTypes.AUDIO_FLAC,
            MimeTypes.AUDIO_ALAC,
            MimeTypes.AUDIO_MPEG,
            MimeTypes.AUDIO_AAC,
            MimeTypes.AUDIO_OPUS,
            MimeTypes.AUDIO_VORBIS,
            MimeTypes.AUDIO_MLAW,
            MimeTypes.AUDIO_ALAW,
            MimeTypes.AUDIO_AC3,
            MimeTypes.AUDIO_E_AC3,
            MimeTypes.AUDIO_DTS,
            MimeTypes.AUDIO_TRUEHD
        )
        for (mime in required) {
            assertTrue(
                "FFmpeg build missing decoder for $mime",
                FfmpegLibrary.supportsFormat(mime)
            )
        }
    }
}
