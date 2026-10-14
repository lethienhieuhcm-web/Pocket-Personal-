package one.lethanhdong.dac

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import one.lethanhdong.dac.player.PlayerManager

/**
 * 4.9: Adapter hàng chờ phát.
 * Kéo-thả đổi thứ tự và vuốt xoá do ItemTouchHelper trong QueueActivity xử lý;
 * adapter chỉ giữ list hiển thị (activity đồng bộ với PlayerManager).
 */
class QueueAdapter : RecyclerView.Adapter<QueueAdapter.VH>() {

    private val items = mutableListOf<PlayerManager.QueueEntry>()
    var currentIndex: Int = -1
        private set

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val position: TextView = v.findViewById(R.id.queuePosition)
        val title: TextView = v.findViewById(R.id.queueTitle)
        val artist: TextView = v.findViewById(R.id.queueArtist)
        val badge: TextView = v.findViewById(R.id.queuePlayingBadge)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_queue, parent, false)
        return VH(v)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val e = items[position]
        holder.position.text = "${position + 1}"
        holder.title.text = e.track.title.ifEmpty { "(không tên)" }
        holder.artist.text = e.track.artist
        holder.artist.visibility = if (e.track.artist.isEmpty()) View.GONE else View.VISIBLE
        holder.badge.visibility = if (position == currentIndex) View.VISIBLE else View.GONE
    }

    fun submitList(entries: List<PlayerManager.QueueEntry>, current: Int) {
        items.clear()
        items.addAll(entries)
        currentIndex = current
        notifyDataSetChanged()
    }

    /** Đổi chỗ trong list hiển thị (gọi trước khi báo về PlayerManager). */
    fun moveInUi(from: Int, to: Int) {
        if (from !in items.indices || to !in items.indices) return
        val e = items.removeAt(from)
        items.add(to, e)
        // currentIndex dịch theo khi bài đang phát bị kéo qua
        currentIndex = when {
            currentIndex == from -> to
            from < currentIndex && to >= currentIndex -> currentIndex - 1
            from > currentIndex && to <= currentIndex -> currentIndex + 1
            else -> currentIndex
        }
        notifyItemMoved(from, to)
        if (currentIndex >= 0) notifyItemChanged(currentIndex)
    }

    fun removeInUi(index: Int) {
        if (index !in items.indices) return
        items.removeAt(index)
        if (currentIndex > index) currentIndex--
        notifyItemRemoved(index)
    }
}
