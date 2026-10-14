package one.lethanhdong.dac.player

import kotlinx.serialization.Serializable

/**
 * Model JSON cho Worker API — plan dac-app 1.4 (kotlinx.serialization,
 * thay JSONObject thủ công). Field nào app không cần thì không khai báo —
 * Json.ignoreUnknownKeys sẽ bỏ qua field lạ từ Worker.
 */

// --- Auth (POST /api/auth/login, /api/auth/register) ---

@Serializable
data class Fingerprint(
    val screen: String,
    val tz: String,
    val lang: String,
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val fp: Fingerprint,
)

@Serializable
data class RegisterRequest(
    val email: String,
    val password: String,
)

@Serializable
data class RegisterResponse(
    val ok: Boolean = false,
    val email: String = "",
    val verified: Boolean = false,
    val needsVerification: Boolean = false,
    val emailSent: Boolean = false,
)

@Serializable
data class AuthResponse(
    val token: String,
    val email: String = "",
)

@Serializable
data class ErrorResponse(
    val error: String = "",
    val details: String = "",
    val driveError: String = "",
    val needsVerification: Boolean = false,
)

/**
 * 2.2: Exception riêng khi email chưa verify — UI hiện thông báo +
 * nút "Gửi lại email xác nhận" thay vì message lỗi chung.
 */
class EmailNotVerifiedException : IllegalStateException("Email chưa được xác nhận. Vui lòng kiểm tra hộp thư và bấm link xác nhận.")

// --- dac-pass (GET /api/dac/music, /api/dac/stream/{id}) ---

@Serializable
data class DriveFile(
    val id: String,
    val name: String,
    val size: Long = 0,
    val mimeType: String = "",
)

@Serializable
data class MusicListResponse(
    val files: List<DriveFile> = emptyList(),
)

@Serializable
data class StreamResponse(
    val url: String,
    val name: String = "",
    val mimeType: String = "",
    val size: Long = 0,
)

// --- dac-app 2.1: Drive Copy từ share link ---

@Serializable
data class ResolveRequest(
    val link: String,
)

@Serializable
data class ResolveResponse(
    val id: String = "",
    val name: String = "",
    val isFolder: Boolean = false,
    val files: List<DriveFile> = emptyList(),
)

@Serializable
data class CopyRequest(
    val sourceId: String,
    val destName: String = "",
)

@Serializable
data class CopyResponse(
    val copiedId: String = "",
    val name: String = "",
    val size: Long = 0,
    val mimeType: String = "",
    val method: String = "",
)
