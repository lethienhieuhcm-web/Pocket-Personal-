package one.lethanhdong.dac.player

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import one.lethanhdong.dac.R

/**
 * Dialog hiển thị đường tín hiệu (Signal Path).
 *
 * Hiện 5 khâu: File → Decode → Volume → USB → DAC.
 * Mỗi khâu có dot xanh/vàng + chi tiết.
 */
class SignalPathDialog(
    context: Context,
    private val result: SignalPath.Result
) : Dialog(context) {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = LayoutInflater.from(context)
            .inflate(R.layout.dialog_signal_path, null)
        setContentView(view)

        val container = view.findViewById<LinearLayout>(R.id.stagesContainer)
        val summary = view.findViewById<TextView>(R.id.summaryText)

        // Vẽ từng khâu
        result.stages.forEach { stage ->
            val row = LayoutInflater.from(context)
                .inflate(R.layout.item_signal_stage, container, false)

            val dot = row.findViewById<TextView>(R.id.stageDot)
            val title = row.findViewById<TextView>(R.id.stageTitle)
            val detail = row.findViewById<TextView>(R.id.stageDetail)
            val warning = row.findViewById<TextView>(R.id.stageWarning)

            // Dot màu
            dot.text = if (stage.isBitPerfect) "●" else "●"
            dot.setTextColor(
                if (stage.isBitPerfect) 0xFF0D9D6C.toInt()
                else 0xFFD4A017.toInt()
            )

            title.text = stage.title
            detail.text = buildString {
                append(stage.detail)
                if (stage.subDetail != null) append("\n${stage.subDetail}")
            }

            if (stage.warning != null) {
                warning.text = "⚠ ${stage.warning}"
                warning.visibility = View.VISIBLE
            } else {
                warning.visibility = View.GONE
            }

            container.addView(row)
        }

        // Tóm tắt
        summary.text = if (result.isBitPerfect) {
            "✅ Nguyên chất — không chạm bits"
        } else {
            "⚠ Đã chạm bits ở ${result.touchedStages.size} khâu"
        }
        summary.setTextColor(
            if (result.isBitPerfect) 0xFF0D9D6C.toInt()
            else 0xFFD4A017.toInt()
        )
    }
}
