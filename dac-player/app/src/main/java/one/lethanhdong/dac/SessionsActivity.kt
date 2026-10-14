package one.lethanhdong.dac

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.AuthManager
import one.lethanhdong.dac.player.LoginSession

/**
 * 4.7: Quản lý phiên đăng nhập — trang riêng (không modal, theo quy tắc).
 * Liệt kê thiết bị đang đăng nhập, thu hồi từng phiên hoặc tất cả thiết bị khác.
 */
class SessionsActivity : AppCompatActivity() {

    private lateinit var authManager: AuthManager
    private lateinit var adapter: SessionAdapter
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sessions)

        authManager = AuthManager(this)
        statusText = findViewById(R.id.sessionsStatus)

        adapter = SessionAdapter { session -> revokeOne(session) }
        findViewById<RecyclerView>(R.id.sessionsList).apply {
            layoutManager = LinearLayoutManager(this@SessionsActivity)
            adapter = this@SessionsActivity.adapter
        }

        findViewById<Button>(R.id.revokeOthersButton).setOnClickListener {
            revokeOthers()
        }
        findViewById<Button>(R.id.backButton).setOnClickListener { finish() }

        loadSessions()
    }

    private fun loadSessions() {
        statusText.text = "Đang tải…"
        lifecycleScope.launch {
            try {
                val sessions = authManager.listSessions()
                adapter.submitList(sessions)
                statusText.text =
                    if (sessions.isEmpty()) "Không có phiên nào."
                    else "${sessions.size} phiên đang hoạt động."
            } catch (e: Exception) {
                statusText.text = "Lỗi: ${e.message}"
            }
        }
    }

    private fun revokeOne(session: LoginSession) {
        lifecycleScope.launch {
            try {
                val n = authManager.revokeSession(session.token_prefix)
                Toast.makeText(
                    this@SessionsActivity,
                    if (n > 0) "Đã thu hồi phiên." else "Không tìm thấy phiên.",
                    Toast.LENGTH_SHORT,
                ).show()
                loadSessions()
            } catch (e: Exception) {
                Toast.makeText(this@SessionsActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun revokeOthers() {
        lifecycleScope.launch {
            try {
                val n = authManager.revokeAllOthers()
                Toast.makeText(
                    this@SessionsActivity,
                    "Đã đăng xuất $n thiết bị khác.",
                    Toast.LENGTH_SHORT,
                ).show()
                loadSessions()
            } catch (e: Exception) {
                Toast.makeText(this@SessionsActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }
}
