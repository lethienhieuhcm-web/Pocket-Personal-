package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Test validate client cho form auth — plan dac-app 1.3.
 * Chạy trên emulator CI (không cần network / server).
 */
@RunWith(AndroidJUnit4::class)
class AuthValidatorTest {

    @Test
    fun validCredentials_returnsNull() {
        assertNull(AuthValidator.validate("user@example.com", "password123"))
    }

    @Test
    fun emptyEmail_returnsError() {
        assertEquals("Nhập email", AuthValidator.validate("", "password123"))
        assertEquals("Nhập email", AuthValidator.validate("   ", "password123"))
    }

    @Test
    fun malformedEmail_returnsError() {
        assertEquals(
            "Email không đúng định dạng",
            AuthValidator.validate("notanemail", "password123")
        )
        assertEquals(
            "Email không đúng định dạng",
            AuthValidator.validate("user@", "password123")
        )
        assertEquals(
            "Email không đúng định dạng",
            AuthValidator.validate("user name@example.com", "password123")
        )
    }

    @Test
    fun shortPassword_returnsError() {
        assertEquals(
            "Mật khẩu tối thiểu 8 ký tự",
            AuthValidator.validate("user@example.com", "1234567")
        )
    }

    @Test
    fun exactlyEightCharPassword_isValid() {
        assertNull(AuthValidator.validate("user@example.com", "12345678"))
    }

    @Test
    fun emailWithSpaces_isTrimmed() {
        assertNull(AuthValidator.validate("  user@example.com  ", "password123"))
    }
}
