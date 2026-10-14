package one.lethanhdong.dac

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import one.lethanhdong.dac.player.MusicApiClient

/** 4.9: Adapter danh sách playlist (D1). */
class PlaylistAdapter(
    private val onLoad: (MusicApiClient.PlaylistSummary) -> Unit,
    private val onDelete: (MusicApiClient.PlaylistSummary) -> Unit,
) : ListAdapter<MusicApiClient.PlaylistSummary, PlaylistAdapter.VH>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<MusicApiClient.PlaylistSummary>() {
            override fun areItemsTheSame(
                a: MusicApiClient.PlaylistSummary,
                b: MusicApiClient.PlaylistSummary,
            ): Boolean = a.id == b.id
            override fun areContentsTheSame(
                a: MusicApiClient.PlaylistSummary,
                b: MusicApiClient.PlaylistSummary,
            ): Boolean = a == b
        }
    }

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val name: TextView = v.findViewById(R.id.playlistName)
        val count: TextView = v.findViewById(R.id.playlistCount)
        val loadButton: Button = v.findViewById(R.id.playlistLoadButton)
        val deleteButton: Button = v.findViewById(R.id.playlistDeleteButton)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_playlist, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val p = getItem(position)
        holder.name.text = p.name
        holder.count.text = "${p.itemCount} bài"
        holder.loadButton.setOnClickListener { onLoad(p) }
        holder.deleteButton.setOnClickListener { onDelete(p) }
    }
}
