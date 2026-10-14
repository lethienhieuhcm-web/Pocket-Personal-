package one.lethanhdong.dac

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import one.lethanhdong.dac.player.LoginSession

/**
 * 4.7: Adapter danh sách phiên đăng nhập.
 * Nút "Thu hồi" ẩn với phiên hiện tại (server từ chối thu hồi chính mình).
 */
class SessionAdapter(
    private val onRevoke: (LoginSession) -> Unit,
) : ListAdapter<LoginSession, SessionAdapter.VH>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<LoginSession>() {
            override fun areItemsTheSame(a: LoginSession, b: LoginSession): Boolean =
                a.token_prefix == b.token_prefix
            override fun areContentsTheSame(a: LoginSession, b: LoginSession): Boolean =
                a == b
        }
    }

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val deviceLabel: TextView = v.findViewById(R.id.deviceLabel)
        val sessionMeta: TextView = v.findViewById(R.id.sessionMeta)
        val currentBadge: TextView = v.findViewById(R.id.currentBadge)
        val revokeButton: Button = v.findViewById(R.id.revokeButton)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_session, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val s = getItem(position)
        holder.deviceLabel.text = s.deviceLabel()
        val lastActive = if (s.last_active > 0) {
            DateUtils.getRelativeTimeSpanString(
                s.last_active, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS
            ).toString()
        } else {
            "không rõ"
        }
        val ip = s.ip.ifEmpty { "IP không rõ" }
        holder.sessionMeta.text = "$ip · Hoạt động: $lastActive"
        holder.currentBadge.visibility = if (s.current) View.VISIBLE else View.GONE
        holder.revokeButton.visibility = if (s.current) View.GONE else View.VISIBLE
        holder.revokeButton.setOnClickListener { onRevoke(s) }
    }
}
