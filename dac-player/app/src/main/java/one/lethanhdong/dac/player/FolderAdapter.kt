package one.lethanhdong.dac.player

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import one.lethanhdong.dac.R

/**
 * Adapter danh sách thư mục Drive — dac-app 4.1 (duyệt theo thư mục).
 * Mỗi dòng: icon folder + tên. Bấm vào → drill xuống thư mục con.
 */
class FolderAdapter(
    private val onFolderClick: (DriveFolder) -> Unit,
) : ListAdapter<DriveFolder, FolderAdapter.FolderViewHolder>(DIFF) {

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<DriveFolder>() {
            override fun areItemsTheSame(a: DriveFolder, b: DriveFolder) =
                a.id == b.id
            override fun areContentsTheSame(a: DriveFolder, b: DriveFolder) =
                a == b
        }
    }

    inner class FolderViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val nameView: TextView = view.findViewById(R.id.folderNameView)

        fun bind(folder: DriveFolder) {
            nameView.text = folder.name.ifEmpty { "(không tên)" }
            itemView.setOnClickListener { onFolderClick(folder) }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FolderViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_folder, parent, false)
        return FolderViewHolder(view)
    }

    override fun onBindViewHolder(holder: FolderViewHolder, position: Int) {
        holder.bind(getItem(position))
    }
}
