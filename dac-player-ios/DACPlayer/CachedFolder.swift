import Foundation
import SwiftData

/// v3.0: SwiftData model cho folder cache.
/// Lưu cấu trúc thư mục để duyệt nhanh (<50ms), không gọi API mỗi lần.
@Model
final class CachedFolder {
    @Attribute(.unique) var id: String
    var name: String
    var parentId: String
    /// Path đầy đủ vd "/Nhạc/FLAC/" — hiện breadcrumb không cần API.
    var path: String
    var cachedAt: Date

    init(id: String, name: String, parentId: String, path: String = "") {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.path = path
        self.cachedAt = Date()
    }
}
