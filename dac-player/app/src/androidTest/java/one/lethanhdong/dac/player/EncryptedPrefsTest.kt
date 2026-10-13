package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented test cho dac-app Phase 1.2 — chạy trên emulator CI (connectedDebugAndroidTest).
 *
 * Verify đúng acceptance của plan Step 1.2: token không bao giờ xuất hiện plain text
 * trong SharedPreferences sau migrate. Dùng file prefs RIÊNG cho test ("test_plain",
 * "test_enc") để không đụng data thật của app.
 */
@RunWith(AndroidJUnit4::class)
class EncryptedPrefsTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteSharedPreferences(PLAIN)
        context.deleteSharedPreferences(ENC)
    }

    @After
    fun tearDown() {
        context.deleteSharedPreferences(PLAIN)
        context.deleteSharedPreferences(ENC)
    }

    @Test
    fun migration_copiesPlainToEncryptedAndDeletesPlain() {
        // Giả lập app cũ: token plain trong file cũ.
        val plain = context.getSharedPreferences(PLAIN, Context.MODE_PRIVATE)
        plain.edit()
            .putString("authToken", "old-token-plain-123")
            .putString("authEmail", "old@example.com")
            .commit()

        val encrypted = EncryptedPrefs.open(
            context,
            plainName = PLAIN,
            encryptedName = ENC,
            migrateKeys = mapOf("authToken" to "session_token", "authEmail" to "authEmail"),
        )

        assertEquals("old-token-plain-123", encrypted.getString("session_token", null))
        assertEquals("old@example.com", encrypted.getString("authEmail", null))
        // File plain đã bị xoá hẳn (không còn sót token plain).
        assertFalse("plain prefs file must be deleted", prefsFile(PLAIN).exists())
    }

    @Test
    fun encryptedFile_doesNotContainPlainToken() {
        val encrypted = EncryptedPrefs.open(
            context,
            plainName = PLAIN,
            encryptedName = ENC,
            migrateKeys = mapOf("authToken" to "session_token"),
        )
        encrypted.edit().putString("session_token", "secret-token-xyz-789").commit()

        // Đọc raw file encrypted: token KHÔNG được xuất hiện dạng plain text.
        val raw = prefsFile(ENC).readText()
        assertFalse("token must not appear in plain text", raw.contains("secret-token-xyz-789"))
        // Đọc lại qua API phải ra đúng giá trị (mã hoá hoạt động 2 chiều).
        assertEquals("secret-token-xyz-789", encrypted.getString("session_token", null))
    }

    @Test
    fun existingEncryptedValue_isNotOverwrittenByPlain() {
        // Encrypted đã có token mới hơn → plain cũ (stale) không được ghi đè.
        val encryptedFirst = EncryptedPrefs.open(
            context,
            plainName = PLAIN,
            encryptedName = ENC,
            migrateKeys = mapOf("authToken" to "session_token"),
        )
        encryptedFirst.edit().putString("session_token", "new-token-keep-me").commit()

        // Plain cũ vẫn còn token stale (vd app crash giữa migrate lần trước).
        val plain = context.getSharedPreferences(PLAIN, Context.MODE_PRIVATE)
        plain.edit().putString("authToken", "stale-old-token").commit()

        val encrypted = EncryptedPrefs.open(
            context,
            plainName = PLAIN,
            encryptedName = ENC,
            migrateKeys = mapOf("authToken" to "session_token"),
        )
        assertEquals("new-token-keep-me", encrypted.getString("session_token", null))
        // Token stale plain vẫn phải bị xoá (không để sót plain).
        assertFalse("plain prefs file must be deleted", prefsFile(PLAIN).exists())
    }

    @Test
    fun unknownPlainKeys_arePreserved() {
        // Key lạ không có trong migrateKeys → không copy, không xoá (an toàn data).
        val plain = context.getSharedPreferences(PLAIN, Context.MODE_PRIVATE)
        plain.edit().putString("some_unknown_key", "keep-me").commit()

        EncryptedPrefs.open(
            context,
            plainName = PLAIN,
            encryptedName = ENC,
            migrateKeys = mapOf("authToken" to "session_token"),
        )

        assertTrue("unknown key must be preserved", prefsFile(PLAIN).exists())
        assertEquals(
            "keep-me",
            context.getSharedPreferences(PLAIN, Context.MODE_PRIVATE)
                .getString("some_unknown_key", null),
        )
    }

    private fun prefsFile(name: String): File {
        // /data/data/<package>/shared_prefs/<name>.xml
        return File(context.applicationInfo.dataDir, "shared_prefs/$name.xml")
    }

    companion object {
        private const val PLAIN = "test_plain"
        private const val ENC = "test_enc"
    }
}
