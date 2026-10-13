package one.lethanhdong.dac.player

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Mở SharedPreferences đã mã hoá + migrate từ file plain cũ — dac-app Phase 1.2.
 *
 * - Mã hoá: EncryptedSharedPreferences, MasterKey AES-256-GCM (Keystore),
 *   key AES256_SIV, value AES256_GCM (chuẩn của androidx.security:security-crypto 1.1.0).
 * - Migrate (chạy 1 lần duy nhất): đọc file plain cũ → copy vào encrypted → xoá key plain.
 *   File encrypted phải KHÁC tên file plain (EncryptedSharedPreferences không đọc được
 *   giá trị plain có sẵn trong cùng file — nó sẽ lỗi giải mã).
 * - Keystore hỏng (keyset corrupt — lỗi đã biết của EncryptedSharedPreferences):
 *   xoá file encrypted + thử lại 1 lần. Vẫn lỗi → throw, user đăng nhập lại.
 *   KHÔNG fallback về plain (fallback = mất hết ý nghĩa của 1.2).
 * - Key plain cũ đã migrate (kể cả khi encrypted đã có giá trị mới hơn) luôn bị xoá khỏi
 *   file plain — token plain cũ là token stale, không được để sót lại.
 *
 * @param migrateKeys map oldKey (plain) -> newKey (encrypted), vd "authToken" -> "session_token".
 *   Key không có trong map sẽ KHÔNG bị copy/xoá (an toàn, không mất data lạ).
 */
object EncryptedPrefs {

    fun open(
        context: Context,
        plainName: String,
        encryptedName: String,
        migrateKeys: Map<String, String>,
    ): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val encrypted = try {
            createEncrypted(context, encryptedName, masterKey)
        } catch (e: Exception) {
            // Keystore hỏng — xoá file encrypted (keyset corrupt) + thử lại 1 lần duy nhất.
            context.deleteSharedPreferences(encryptedName)
            createEncrypted(context, encryptedName, masterKey)
        }

        // Migrate từ plain → encrypted, chỉ khi encrypted chưa có key đó (không ghi đè).
        val plain = context.getSharedPreferences(plainName, Context.MODE_PRIVATE)
        if (plain.all.isNotEmpty()) {
            val plainEditor = plain.edit()
            val encryptedEditor = encrypted.edit()
            var changed = false
            for ((oldKey, newKey) in migrateKeys) {
                if (!plain.contains(oldKey)) continue
                if (!encrypted.contains(newKey)) {
                    val value = plain.getString(oldKey, null)
                    if (value != null) {
                        encryptedEditor.putString(newKey, value)
                        changed = true
                    }
                }
                // Xoá key plain dù có copy hay không (token plain cũ = stale, phải xoá).
                plainEditor.remove(oldKey)
                changed = true
            }
            if (changed) {
                // commit() đồng bộ (không apply()): đảm bảo ghi đĩa xong TRƯỚC khi xoá file plain.
                // apply() ghi async — deleteSharedPreferences chạy trước khi ghi xong sẽ bị
                // ghi đè lại (tạo lại file plain), race đã biết của SharedPreferences.
                encryptedEditor.commit()
                plainEditor.commit()
            }
            // File plain trống → xoá hẳn file để không còn sót.
            if (plain.all.isEmpty()) {
                context.deleteSharedPreferences(plainName)
            }
        }
        return encrypted
    }

    private fun createEncrypted(
        context: Context,
        encryptedName: String,
        masterKey: MasterKey,
    ): SharedPreferences {
        return EncryptedSharedPreferences.create(
            context,
            encryptedName,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }
}
