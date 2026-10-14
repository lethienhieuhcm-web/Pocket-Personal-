package one.lethanhdong.dac.player

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import coil.ImageLoader
import coil.load
import one.lethanhdong.dac.R

/**
 * Adapter danh sách nhạc — plan "dac" D2 + dac-app 1.4 (ảnh bìa Coil).
 * Hiển thị ảnh bìa + title + badge định dạng (kiểu UAPP: FLAC, MP3...).
 * Ảnh bìa = ảnh nhúng trong file (CoverArtFetcher); không có → placeholder ic_music_note.
 */
class TrackAdapter(
    private val onTrackClick: (MusicApiClient.Track) -> Unit,
    private val imageLoader: ImageLoader,
    /** 4.3: bấm nút tải → activity xử lý download. Null = ẩn nút tải. */
    private val onDownloadClick: ((MusicApiClient.Track) -> Unit)? = null,
    /** 4.3: track đã tải offline chưa — để hiện trạng thái nút. */
    private val isDownloaded: (String) -> Boolean = { false },
) : ListAdapter<MusicApiClient.Track, TrackAdapter.TrackViewHolder>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<MusicApiClient.Track>() {
            override fun areItemsTheSame(a: MusicApiClient.Track, b: MusicApiClient.Track) =
                a.id == b.id
            override fun areContentsTheSame(a: MusicApiClient.Track, b: MusicApiClient.Track) =
                a == b
        }

        /** Badge định dạng — 4.4: delegate sang AudioFormat (single source of truth). */
        fun formatBadge(mimeType: String, title: String): String =
            AudioFormat.formatLabel(mimeType, title)
    }

    inner class TrackViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val coverView: ImageView = view.findViewById(R.id.coverView)
        private val titleView: TextView = view.findViewById(R.id.titleView)
        private val badgeView: TextView = view.findViewById(R.id.badgeView)
        private val downloadButton: ImageButton = view.findViewById(R.id.downloadButton)

        fun bind(track: MusicApiClient.Track) {
            titleView.text = track.title
            badgeView.text = formatBadge(track.mimeType, track.title)
            // 1.4: ảnh bìa qua Coil (CoverArtFetcher → ảnh nhúng, cache theo id+size).
            coverView.load(CoverArtKey(track.id, track.size), imageLoader) {
                placeholder(R.drawable.ic_music_note)
                error(R.drawable.ic_music_note)
                crossfade(true)
            }
            itemView.setOnClickListener { onTrackClick(track) }
            // 4.3: nút tải offline.
            if (onDownloadClick != null) {
                downloadButton.visibility = View.VISIBLE
                val done = isDownloaded(track.id)
                downloadButton.alpha = if (done) 1f else 0.5f
                downloadButton.contentDescription = itemView.context.getString(
                    if (done) R.string.downloaded_offline else R.string.download_offline
                )
                downloadButton.setOnClickListener { onDownloadClick.invoke(track) }
            } else {
                downloadButton.visibility = View.GONE
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): TrackViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_track, parent, false)
        return TrackViewHolder(view)
    }

    override fun onBindViewHolder(holder: TrackViewHolder, position: Int) {
        holder.bind(getItem(position))
    }
}
