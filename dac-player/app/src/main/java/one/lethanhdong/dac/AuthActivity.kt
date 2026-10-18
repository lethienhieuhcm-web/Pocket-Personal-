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
import one.lethanhdong.dac.player.DacAuthManager
import one.lethanhdong.dac.player.AuthValidator
import one.lethanhdong.dac.player.EmailNotVerifiedException
import one.lethanhdong.dac.player.GoogleSignInManager

/**
 * AuthActivity — plan dac-app 1.3: màn hình Đăng nhập / Đăng ký TÁCH RIÊNG
 * khỏi MainActivity (trước đây form auth nằm chung trong MainActivity).
 *
 * Đăng nhập / đăng ký thành công → vào MainActivity (thư viện + phát nhạc).
 * MainActivity chỉ chạy khi đã đăng nhập; chưa đăng nhập → về đây.
 * Lỗi hiển thị inline trong [errorText] (không Toast — Toast trôi mất,
 * user không đọc kịp message rate limit).
 *
 * 2.2: Thêm luồng xác nhận email (token link) + quên mật khẩu.
 */
class AuthActivity : AppCompatActivity() {

    private lateinit var authManager: AuthManager
    private lateinit var dacAuthManager: DacAuthManager
    private lateinit var emailInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var errorText: TextView
    private lateinit var loginButton: Button
    private lateinit var registerButton: Button
    private lateinit var forgotPasswordButton: TextView
    private lateinit var resendButton: Button
    private lateinit var googleSignInButton: Button
    // 2.4: Web OAuth client ID (client Web app của lethanhdong.one, đã verify
    // từ flow OAuth live 2026-10-14). Dùng cho `aud` khi Worker verify ID token.
    private val googleWebClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_auth)

        authManager = AuthManager(this)
        dacAuthManager = DacAuthManager(this)

        emailInput = findViewById(R.id.emailInput)
        passwordInput = findViewById(R.id.passwordInput)
        errorText = findViewById(R.id.errorText)
        loginButton = findViewById(R.id.loginButton)
        registerButton = findViewById(R.id.registerButton)
        forgotPasswordButton = findViewById(R.id.forgotPasswordButton)
        resendButton = findViewById(R.id.resendButton)
        googleSignInButton = findViewById(R.id.googleSignInButton)

        loginButton.setOnClickListener { doLogin() }
        registerButton.setOnClickListener { doRegister() }
        forgotPasswordButton.setOnClickListener { doForgotPassword() }
        resendButton.setOnClickListener { doResendVerification() }
        googleSignInButton.setOnClickListener { doGoogleSignIn() }
    }

    private fun showError(message: String) {
        errorText.text = message
        errorText.visibility = View.VISIBLE
    }

    private fun showInfo(message: String) {
        errorText.text = message
        errorText.setTextColor(getColor(android.R.color.holo_green_dark))
        errorText.visibility = View.VISIBLE
    }

    private fun clearError() {
        errorText.visibility = View.GONE
        errorText.setTextColor(getColor(android.R.color.holo_red_dark))
        resendButton.visibility = View.GONE
    }

    private fun setBusy(busy: Boolean) {
        loginButton.isEnabled = !busy
        registerButton.isEnabled = !busy
        forgotPasswordButton.isEnabled = !busy
        resendButton.isEnabled = !busy
        googleSignInButton.isEnabled = !busy
    }

    /**
     * 2.4: Đăng nhập bằng Google qua Credential Manager.
     */
    private fun doGoogleSignIn() {
        clearError()
        setBusy(true)
        lifecycleScope.launch {
            try {
                val manager = GoogleSignInManager(
                    this@AuthActivity,
                    webClientId = googleWebClientId,
                )
                manager.signIn()
                // Thành công → vào MainActivity
                startActivity(Intent(this@AuthActivity, MainActivity::class.java))
                finish()
            } catch (e: Exception) {
                showError(e.message ?: "Đăng nhập Google thất bại")
            } finally {
                setBusy(false)
            }
        }
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
                // 4.6: Đăng nhập DAC auth riêng (không chặn nếu lỗi — web session vẫn dùng được)
                try {
                    dacAuthManager.login(email, password)
                } catch (e: Exception) {
                    // bỏ qua, DAC endpoints chấp nhận cả web session
                }
                goToMain()
            } catch (e: EmailNotVerifiedException) {
                // 2.2: hiện nút gửi lại email xác nhận
                showError(e.message ?: "Email chưa được xác nhận")
                resendButton.visibility = View.VISIBLE
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
                val result = authManager.register(email, password)
                if (result.needsVerification) {
                    // 2.2: đăng ký xong nhưng chưa verify → báo user check email
                    showInfo("Đã gửi email xác nhận. Vui lòng bấm link trong email rồi đăng nhập.")
                    resendButton.visibility = View.VISIBLE
                } else {
                    // Đã verify (web flow) → tự động đăng nhập luôn (plan 1.3)
                    authManager.login(email, password)
                    goToMain()
                }
            } catch (e: Exception) {
                showError(e.message ?: "Lỗi đăng ký")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun doForgotPassword() {
        val email = emailInput.text.toString().trim()
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            showError("Vui lòng nhập email trước")
            return
        }
        clearError()
        setBusy(true)
        lifecycleScope.launch {
            try {
                authManager.forgotPassword(email)
                // Luôn báo đã gửi (server không tiết lộ email có tồn tại)
                showInfo("Nếu email này đã đăng ký, bạn sẽ nhận được link đặt lại mật khẩu.")
            } catch (e: Exception) {
                showError(e.message ?: "Lỗi gửi email")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun doResendVerification() {
        val email = emailInput.text.toString().trim()
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            showError("Vui lòng nhập email trước")
            return
        }
        clearError()
        setBusy(true)
        lifecycleScope.launch {
            try {
                authManager.resendVerification(email)
                showInfo("Đã gửi lại email xác nhận. Vui lòng kiểm tra hộp thư.")
                resendButton.visibility = View.VISIBLE
            } catch (e: Exception) {
                showError(e.message ?: "Lỗi gửi email")
            } finally {
                setBusy(false)
            }
        }
    }
}
