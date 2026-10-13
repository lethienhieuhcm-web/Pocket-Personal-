package one.lethanhdong.dac.player

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

/**
 * Adapter danh sách nhạc — plan "dac" D2.
 * Hiển thị title + badge định dạng (kiểu UAPP: FLAC, MP3...).
 */
class TrackAdapter(
    private val onTrackClick: (MusicApiClient.Track) -> Unit,
) : ListAdapter<MusicApiClient.Track, TrackAdapter.TrackViewHolder>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<MusicApiClient.Track>() {
            override fun areItemsTheSame(a: MusicApiClient.Track, b: MusicApiClient.Track) =
                a.id == b.id
            override fun areContentsTheSame(a: MusicApiClient.Track, b: MusicApiClient.Track) =
                a == b
        }

        /** Badge định dạng từ mimeType — đơn giản D2, đo thật ở phase sau. */
        fun formatBadge(mimeType: String, title: String): String {
            val mt = mimeType.lowercase()
            return when {
                "flac" in mt || title.lowercase().endsWith(".flac") -> "FLAC"
                "wav" in mt || title.lowercase().endsWith(".wav") -> "WAV"
                "mp3" in mt || "mpeg" in mt -> "MP3"
                "m4a" in mt || "mp4" in mt -> "M4A"
                "ogg" in mt || "opus" in mt -> "OGG"
                else -> "AUDIO"
            }
        }
    }

    inner class TrackViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val titleView: TextView = view.findViewById(android.R.id.text1)
        private val badgeView: TextView = view.findViewById(android.R.id.text2)

        fun bind(track: MusicApiClient.Track) {
            titleView.text = track.title
            badgeView.text = formatBadge(track.mimeType, track.title)
            itemView.setOnClickListener { onTrackClick(track) }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): TrackViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(android.R.layout.simple_list_item_2, parent, false)
        return TrackViewHolder(view)
    }

    override fun onBindViewHolder(holder: TrackViewHolder, position: Int) {
        holder.bind(getItem(position))
    }
}
