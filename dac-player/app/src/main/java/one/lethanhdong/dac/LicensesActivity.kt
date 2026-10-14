package one.lethanhdong.dac

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 1.5: Màn hình Giấy phép mã nguồn mở (Settings → About → Open Source Licenses).
 * Hiển thị docs/THIRD_PARTY_NOTICES.md — file được copy vào assets lúc build
 * (copyLicenses trong app/build.gradle.kts), single source of truth, không drift.
 * Nghĩa vụ LGPL: FFmpeg source + license phải xem được trong app.
 */
class LicensesActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_licenses)
        val textView = findViewById<TextView>(R.id.licensesText)
        textView.text = try {
            assets.open("third_party_notices.md").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            getString(R.string.licenses_missing)
        }
    }
}
