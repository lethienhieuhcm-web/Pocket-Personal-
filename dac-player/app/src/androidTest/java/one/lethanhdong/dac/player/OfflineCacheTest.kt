package one.lethanhdong.dac.player

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.3: test cache offline + retry backoff.
 * - backoffDelayMs: đúng khoảng exponential + cap.
 * - extForFileName/fileNameFor: logic thuần.
 * - OfflineManager: localFile/isDownloaded/delete với Room in-memory
 *   (không cần mạng — giả lập file đã tải bằng cách ghi trực tiếp).
 */
@RunWith(AndroidJUnit4::class)
class OfflineCacheTest {

    private lateinit var context: Context
    private lateinit var db: MusicDatabase
    private lateinit var dao: OfflineTrackDao
    private lateinit var manager: OfflineManager

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, MusicDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.offlineTrackDao()
        manager = OfflineManager(context, dao)
        manager.storageDir.mkdirs()
    }

    @After
    fun teardown() {
        manager.storageDir.deleteRecursively()
        db.close()
    }

    @Test
    fun backoffDelay_inRange() {
        // attempt 1 → 1000–1500ms
        repeat(20) {
            val d = ApiHttp.backoffDelayMs(1)
            assertTrue("attempt1=$d", d in 1000L..1500L)
        }
        // attempt 2 → 2000–2500ms
        repeat(20) {
            val d = ApiHttp.backoffDelayMs(2)
            assertTrue("attempt2=$d", d in 2000L..2500L)
        }
        // attempt 3 → 4000–4500ms
        repeat(20) {
            val d = ApiHttp.backoffDelayMs(3)
            assertTrue("attempt3=$d", d in 4000L..4500L)
        }
        // attempt lớn → cap 8000–8500ms
        repeat(20) {
            val d = ApiHttp.backoffDelayMs(10)
            assertTrue("attempt10=$d", d in 8000L..8500L)
        }
    }

    @Test
    fun extForFileName_cases() {
        assertEquals("flac", OfflineManager.extForFileName("Bai Hat.flac"))
        assertEquals("wav", OfflineManager.extForFileName("x.WAV"))
        assertEquals("mp3", OfflineManager.extForFileName("noext"))
        assertEquals("mp3", OfflineManager.extForFileName("weird."))
        assertEquals("m4a", OfflineManager.extForFileName("a.b.m4a"))
    }

    @Test
    fun fileNameFor_sanitizes() {
        assertEquals("abc123.flac", OfflineManager.fileNameFor("abc123", "flac"))
        // ký tự lạ bị loại để tránh path traversal
        assertEquals("abc123.flac", OfflineManager.fileNameFor("ab/c..123", "flac"))
        assertEquals("abc-123_X.flac", OfflineManager.fileNameFor("abc-123_X", "flac"))
    }

    @Test
    fun localFile_nullWhenNotDownloaded() = runBlocking {
        assertNull(manager.localFile("missing-id"))
        assertFalse(manager.isDownloaded("missing-id"))
    }

    @Test
    fun localFile_returnsFileAfterSimulatedDownload() = runBlocking {
        val trackId = "test-track-1"
        val fileName = OfflineManager.fileNameFor(trackId, "flac")
        // Giả lập file đã tải xong: ghi file + insert entity
        File(manager.storageDir, fileName).writeBytes(ByteArray(1024) { 1 })
        dao.insert(OfflineTrackEntity(trackId, fileName, 1024, System.currentTimeMillis()))

        val f = manager.localFile(trackId)
        assertNotNull(f)
        assertEquals(1024L, f!!.length())
        assertTrue(manager.isDownloaded(trackId))
    }

    @Test
    fun localFile_nullWhenEntityStale() = runBlocking {
        // Entity có nhưng file mất (user xoá tay) → coi như chưa tải
        val trackId = "stale-track"
        dao.insert(
            OfflineTrackEntity(trackId, "$trackId.flac", 100, System.currentTimeMillis())
        )
        assertNull(manager.localFile(trackId))
        assertFalse(manager.isDownloaded(trackId))
    }

    @Test
    fun delete_removesFileAndEntity() = runBlocking {
        val trackId = "test-track-2"
        val fileName = OfflineManager.fileNameFor(trackId, "mp3")
        val f = File(manager.storageDir, fileName)
        f.writeBytes(ByteArray(512))
        dao.insert(OfflineTrackEntity(trackId, fileName, 512, System.currentTimeMillis()))
        assertTrue(manager.isDownloaded(trackId))

        manager.delete(trackId)

        assertFalse(f.exists())
        assertNull(dao.getById(trackId))
        assertFalse(manager.isDownloaded(trackId))
    }
}
