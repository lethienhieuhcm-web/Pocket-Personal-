package one.lethanhdong.dac.player

/**
 * Parse Google Drive share link → file/folder ID — plan dac-app 2.1.
 *
 * Dùng để validate nhanh ở client trước khi gọi Worker /api/dac/resolve
 * (Worker parse lại server-side — đây chỉ là check sơ bộ).
 *
 * Hỗ trợ:
 * - https://drive.google.com/file/d/ID/view...
 * - https://drive.google.com/drive/folders/ID
 * - https://drive.google.com/open?id=ID
 * - https://docs.google.com/document/d/ID/...
 * - ID trần (paste trực tiếp)
 */
object DriveLinkParser {
    // /file/d/ID, /folders/ID, /d/ID
    private val PATH_PATTERN = Regex("""/(?:file/d|folders|d)/([a-zA-Z0-9_-]+)""")
    // ?id=ID hoặc &id=ID
    private val QUERY_PATTERN = Regex("""[?&]id=([a-zA-Z0-9_-]+)""")
    // ID trần: ít nhất 10 ký tự (ID Drive thật dài ~33)
    private val BARE_ID_PATTERN = Regex("""^[a-zA-Z0-9_-]{10,}$""")

    /**
     * Parse link → ID, hoặc null nếu không nhận diện được.
     */
    fun parse(link: String?): String? {
        if (link.isNullOrBlank()) return null
        val t = link.trim()
        PATH_PATTERN.find(t)?.let { return it.groupValues[1] }
        QUERY_PATTERN.find(t)?.let { return it.groupValues[1] }
        if (BARE_ID_PATTERN.matches(t)) return t
        return null
    }

    /** Kiểm tra nhanh link có vẻ là link Drive hợp lệ không. */
    fun looksValid(link: String?): Boolean = parse(link) != null
}
