package one.lethanhdong.dac.player

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Bundle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Quản lý Google Drive OAuth via Android AccountManager — plan "dac-pass".
 *
 * Kiến trúc dac-pass (Chốt 2026-10-13):
 * - App lấy Drive token từ tài khoản Google sẵn có trên máy (dialog hệ thống).
 * - Token gửi lên Worker qua header X-Drive-Token mỗi request.
 * - Worker KHÔNG lưu token, chỉ validate + gọi Drive API (passthrough).
 *
 * Scope: drive.readonly (đã Chốt, deploy Worker 2026-10-13).
 */
open class DriveAuthManager(private val context: Context) {

    companion object {
        const val DRIVE_SCOPE = "oauth2:https://www.googleapis.com/auth/drive.readonly"
        private const val PREFS = "dac_drive"
        private const val KEY_ACCOUNT = "drive_account"
    }

    private val prefs by lazy {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    private val accountManager by lazy {
        AccountManager.get(context)
    }

    /** Tài khoản Google đã chọn (nếu có). */
    fun selectedAccount(): String? = prefs.getString(KEY_ACCOUNT, null)

    /** Danh sách tài khoản Google trên máy. Cần quyền GET_ACCOUNTS. */
    fun googleAccounts(): List<Account> {
        return try {
            accountManager.getAccountsByType("com.google").toList()
        } catch (e: SecurityException) {
            emptyList()
        }
    }

    /** Chọn tài khoản Google để dùng cho Drive. */
    fun selectAccount(accountName: String) {
        prefs.edit().putString(KEY_ACCOUNT, accountName).apply()
    }

    /** Xoá tài khoản đã chọn (ngắt kết nối Drive). */
    fun clearAccount() {
        prefs.edit().remove(KEY_ACCOUNT).apply()
    }

    /**
     * Lấy Drive access token từ AccountManager.
     * Nếu chưa được cấp quyền, hệ thống hiện dialog xin phép user.
     * @param activity Activity để hiện dialog xin quyền (nếu có).
     * @throws IllegalStateException nếu chưa chọn tài khoản hoặc bị từ chối.
     */
    open suspend fun getToken(activity: android.app.Activity? = null): String =
        withContext(Dispatchers.IO) {
            val accountName = selectedAccount()
                ?: throw IllegalStateException("Chưa kết nối Google Drive")
            val account = Account(accountName, "com.google")

            suspendCancellableCoroutine<String> { cont ->
                val future = accountManager.getAuthToken(
                    account,
                    DRIVE_SCOPE,
                    Bundle(),
                    activity,
                    { f ->
                        try {
                            val bundle = f.result
                            val token = bundle.getString(AccountManager.KEY_AUTHTOKEN)
                            if (token.isNullOrEmpty()) {
                                cont.resumeWithException(
                                    IllegalStateException("Không lấy được Drive token")
                                )
                            } else {
                                cont.resume(token)
                            }
                        } catch (e: Exception) {
                            if (!cont.isCompleted) cont.resumeWithException(e)
                        }
                    },
                    /* handler = */ null
                )
                cont.invokeOnCancellation { future.cancel(true) }
            }
        }

    /**
     * Báo token hết hạn để AccountManager lấy token mới lần sau.
     * Gọi khi Worker trả 401 "Drive token invalid".
     */
    open fun invalidateToken(token: String) {
        accountManager.invalidateAuthToken("com.google", token)
    }
}
