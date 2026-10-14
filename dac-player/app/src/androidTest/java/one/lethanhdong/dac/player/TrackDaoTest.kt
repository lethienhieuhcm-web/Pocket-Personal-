package one.lethanhdong.dac.player

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 2.3: Instrumented test cho Room TrackDao.
 * Dùng in-memory database (không ghi file thật).
 */
@RunWith(AndroidJUnit4::class)
class TrackDaoTest {

    private lateinit var db: MusicDatabase
    private lateinit var dao: TrackDao

    @Before
    fun setup() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            MusicDatabase::class.java
        ).allowMainThreadQueries().build()
        dao = db.trackDao()
    }

    @After
    fun teardown() {
        db.close()
    }

    @Test
    fun insertAndGetAll() = runBlocking {
        val tracks = listOf(
            TrackEntity("id1", "Song B", 1000L, "audio/flac"),
            TrackEntity("id2", "Song A", 2000L, "audio/mp3"),
        )
        dao.insertAll(tracks)

        val all = dao.getAll()
        assertEquals(2, all.size)
        // Sắp xếp theo title ASC
        assertEquals("Song A", all[0].title)
        assertEquals("Song B", all[1].title)
    }

    @Test
    fun insertReplaceOnConflict() = runBlocking {
        dao.insertAll(listOf(TrackEntity("id1", "Old Title", 1000L, "audio/flac")))
        dao.insertAll(listOf(TrackEntity("id1", "New Title", 2000L, "audio/flac")))

        val track = dao.getById("id1")
        assertNotNull(track)
        assertEquals("New Title", track!!.title)
        assertEquals(1, dao.count())
    }

    @Test
    fun clearRemovesAll() = runBlocking {
        dao.insertAll(listOf(TrackEntity("id1", "Song", 1000L, "audio/flac")))
        assertEquals(1, dao.count())

        dao.clear()
        assertEquals(0, dao.count())
    }

    @Test
    fun searchByTitle() = runBlocking {
        dao.insertAll(listOf(
            TrackEntity("id1", "Hello World", 1000L, "audio/flac"),
            TrackEntity("id2", "Goodbye", 2000L, "audio/mp3"),
        ))

        val results = dao.search("hello")
        assertEquals(1, results.size)
        assertEquals("id1", results[0].id)
    }

    @Test
    fun oldestCachedAt() = runBlocking {
        assertNull(dao.oldestCachedAt())

        val now = System.currentTimeMillis()
        dao.insertAll(listOf(
            TrackEntity("id1", "A", 1000L, "audio/flac", now - 1000),
            TrackEntity("id2", "B", 2000L, "audio/flac", now),
        ))

        val oldest = dao.oldestCachedAt()
        assertNotNull(oldest)
        assertTrue(oldest!! <= now - 1000)
    }
}
