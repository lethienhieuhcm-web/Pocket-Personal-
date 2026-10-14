package one.lethanhdong.dac

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.AuthManager
import one.lethanhdong.dac.player.AuthValidator

/**
 * AuthActivity — plan dac-app 1.3: màn hình Đăng nhập / Đăng ký TÁCH RIÊNG
 * khỏi MainActivity (trước đây form auth nằm chung trong MainActivity).
 *
 * Đăng nhập / đăng ký thành công → vào MainActivity (thư viện + phát nhạc).
 * MainActivity chỉ chạy khi đã đăng nhập; chưa đăng nhập → về đây.
 * Lỗi hiển thị inline trong [errorText] (không Toast — Toast trôi mất,
 * user không đọc kịp message rate limit).
 */
class AuthActivity : AppCompatActivity() {

    private lateinit var authManager: AuthManager
    private lateinit var emailInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var errorText: TextView
    private lateinit var loginButton: Button
    private lateinit var registerButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_auth)

        authManager = AuthManager(this)

        emailInput = findViewById(R.id.emailInput)
        passwordInput = findViewById(R.id.passwordInput)
        errorText = findViewById(R.id.errorText)
        loginButton = findViewById(R.id.loginButton)
        registerButton = findViewById(R.id.registerButton)

        loginButton.setOnClickListener { doLogin() }
        registerButton.setOnClickListener { doRegister() }
    }

    private fun showError(message: String) {
        errorText.text = message
        errorText.visibility = View.VISIBLE
    }

    private fun clearError() {
        errorText.visibility = View.GONE
    }

    private fun setBusy(busy: Boolean) {
        loginButton.isEnabled = !busy
        registerButton.isEnabled = !busy
    }

    private fun goToMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun doLogin() {
        val email = emailInput.text.toString()
        val password = passwordInput.text.toString()
        val validationError = AuthValidator.validate(email, password)
        if (validationError != null) {
            showError(validationError)
            return
        }
        clearError()
        setBusy(true)
        lifecycleScope.launch {
            try {
                authManager.login(email, password)
                goToMain()
            } catch (e: Exception) {
                showError(e.message ?: "Lỗi đăng nhập")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun doRegister() {
        val email = emailInput.text.toString()
        val password = passwordInput.text.toString()
        val validationError = AuthValidator.validate(email, password)
        if (validationError != null) {
            showError(validationError)
            return
        }
        clearError()
        setBusy(true)
        lifecycleScope.launch {
            try {
                authManager.register(email, password)
                // Đăng ký xong → tự động đăng nhập luôn (plan 1.3)
                authManager.login(email, password)
                goToMain()
            } catch (e: Exception) {
                showError(e.message ?: "Lỗi đăng ký")
            } finally {
                setBusy(false)
            }
        }
    }
}
