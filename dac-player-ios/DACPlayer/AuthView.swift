import SwiftUI

/// Màn hình đăng nhập / đăng ký — dịch từ AuthActivity (Android).
/// Tinh gọn: không popup, lỗi hiện inline.
struct AuthView: View {
    @EnvironmentObject var auth: AuthManager

    @State private var email = ""
    @State private var password = ""
    @State private var isRegisterMode = false
    @State private var errorText: String? = nil
    @State private var infoText: String? = nil
    @State private var showResendButton = false
    @State private var isBusy = false

    private var isValid: Bool {
        email.contains("@") && email.contains(".") && password.count >= 8
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("DAC Pocket")
                    .font(.largeTitle)
                    .bold()
                Text(isRegisterMode ? "Tạo tài khoản" : "Đăng nhập")
                    .font(.title2)
                    .foregroundStyle(.secondary)

                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .autocorrectionDisabled()

                SecureField("Mật khẩu (tối thiểu 8 ký tự)", text: $password)
                    .textFieldStyle(.roundedBorder)

                if let errorText {
                    Text(errorText)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }
                if let infoText {
                    Text(infoText)
                        .foregroundStyle(.green)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }
                if showResendButton {
                    Button("Gửi lại email xác nhận") {
                        Task {
                            let ok = await auth.resendVerification(email: email)
                            infoText = ok ? "Đã gửi email xác nhận. Vui lòng kiểm tra hộp thư."
                                         : "Không gửi được email. Thử lại sau."
                        }
                    }
                    .font(.footnote)
                }

                Button(isRegisterMode ? "Đăng ký" : "Đăng nhập") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid || isBusy)

                Button(isRegisterMode ? "Đã có tài khoản? Đăng nhập" : "Chưa có tài khoản? Đăng ký") {
                    isRegisterMode.toggle()
                    errorText = nil
                    infoText = nil
                    showResendButton = false
                }
                .font(.footnote)

                if !isRegisterMode {
                    Button("Quên mật khẩu?") {
                        Task {
                            let ok = await auth.forgotPassword(email: email)
                            infoText = ok ? "Đã gửi email đặt lại mật khẩu (nếu email tồn tại)."
                                         : "Không gửi được email. Thử lại sau."
                        }
                    }
                    .font(.footnote)
                }

                Spacer()
            }
            .padding()
            .navigationBarHidden(true)
        }
    }

    private func submit() async {
        errorText = nil
        infoText = nil
        showResendButton = false
        isBusy = true
        defer { isBusy = false }
        do {
            if isRegisterMode {
                let resp = try await auth.register(email: email, password: password)
                if resp.needsVerification {
                    infoText = "Đăng ký thành công. Vui lòng bấm link trong email để xác nhận rồi đăng nhập."
                } else {
                    // Server auto-login khi không cần verify — đăng nhập luôn
                    try await auth.login(email: email, password: password)
                }
            } else {
                try await auth.login(email: email, password: password)
            }
        } catch is EmailNotVerifiedError {
            let e = EmailNotVerifiedError()
            errorText = e.message
            showResendButton = true
        } catch AuthError.message(let msg) {
            errorText = msg
        } catch {
            errorText = "Lỗi mạng. Kiểm tra kết nối và thử lại."
        }
    }
}
