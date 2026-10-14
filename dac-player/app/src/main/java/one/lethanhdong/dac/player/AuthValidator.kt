package one.lethanhdong.dac.player

import android.util.Patterns

/**
 * Validate client cho form đăng nhập / đăng ký — plan dac-app 1.3.
 *
 * Trả về thông báo lỗi (tiếng Việt, hiển thị trực tiếp cho user) hoặc null nếu hợp lệ.
 * Tách riêng để test được mà không cần network / Activity (xem AuthValidatorTest).
 */
object AuthValidator {
    fun validate(email: String, password: String): String? {
        val e = email.trim()
        if (e.isEmpty()) return "Nhập email"
        if (!Patterns.EMAIL_ADDRESS.matcher(e).matches()) return "Email không đúng định dạng"
        if (password.length < 8) return "Mật khẩu tối thiểu 8 ký tự"
        return null
    }
}
