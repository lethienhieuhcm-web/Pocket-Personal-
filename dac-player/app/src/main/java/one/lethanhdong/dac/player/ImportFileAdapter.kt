package one.lethanhdong.dac.player

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import one.lethanhdong.dac.R

/**
 * Adapter danh sách file để chọn copy — plan dac-app 2.1.
 * Mỗi dòng có CheckBox; mặc định chọn tất cả.
 */
class ImportFileAdapter :
    ListAdapter<ImportFileAdapter.Item, ImportFileAdapter.VH>(DIFF) {

    data class Item(
        val file: DriveFile,
        var checked: Boolean = true,
    )

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<Item>() {
            override fun areItemsTheSame(a: Item, b: Item) = a.file.id == b.file.id
            override fun areContentsTheSame(a: Item, b: Item) =
                a == b
        }

        /** Format bytes → "12.3 MB" (user-friendly, không bịa số). */
        fun formatSize(bytes: Long): String {
            if (bytes <= 0) return "?"
            val units = arrayOf("B", "KB", "MB", "GB")
            var v = bytes.toDouble()
            var u = 0
            while (v >= 1024 && u < units.size - 1) { v /= 1024; u++ }
            return if (u == 0) "${bytes} B" else "%.1f %s".format(v, units[u])
        }
    }

    /** Danh sách file đang được chọn. */
    fun selectedFiles(): List<DriveFile> = currentList.filter { it.checked }.map { it.file }

    fun setFiles(files: List<DriveFile>) {
        submitList(files.map { Item(it, true) })
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_import_file, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(getItem(position))
    }

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val check: CheckBox = v.findViewById(R.id.fileCheck)
        private val name: TextView = v.findViewById(R.id.fileName)
        private val size: TextView = v.findViewById(R.id.fileSize)

        fun bind(item: Item) {
            name.text = item.file.name
            size.text = formatSize(item.file.size)
            // Gỡ listener cũ trước khi set checked (tránh trigger sai)
            check.setOnCheckedChangeListener(null)
            check.isChecked = item.checked
            check.setOnCheckedChangeListener { _, isChecked ->
                item.checked = isChecked
            }
            itemView.setOnClickListener {
                item.checked = !item.checked
                check.isChecked = item.checked
            }
        }
    }
}
