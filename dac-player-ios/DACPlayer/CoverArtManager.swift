import Foundation
import AVFoundation
import UIKit

/// Đọc ảnh bìa nhúng trong file nhạc — tương đương CoverArtFetcher (Android).
///
/// Không dùng thư viện ngoài: artwork lấy từ metadata của file
/// (AVMetadataKey.commonKeyArtwork), không bịa ảnh từ URL.
/// Không có ảnh nhúng → UI hiện placeholder (SF Symbol, như Android).
@MainActor
class CoverArtManager: ObservableObject {
    private let api: MusicApiClient
    private var cache: [String: UIImage] = [:]

    init(api: MusicApiClient) {
        self.api = api
    }

    /// Ảnh bìa của track (cache theo id). Nil nếu file không nhúng ảnh.
    func artwork(for track: Track) async -> UIImage? {
        if let img = cache[track.id] { return img }
        do {
            let url = try await api.streamURL(for: track.id)
            let asset = AVURLAsset(url: url)
            let allMeta = try await asset.load(.metadata)
            let items = AVMetadataItem.metadataItems(
                from: allMeta,
                withKey: AVMetadataKey.commonKeyArtwork,
                keySpace: .common)
            guard let data = try await items.first?.load(.dataValue),
                  let img = UIImage(data: data) else { return nil }
            cache[track.id] = img
            return img
        } catch {
            return nil
        }
    }

    func clearCache() {
        cache.removeAll()
    }
}
