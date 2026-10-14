import SwiftUI

/// Ô ảnh bìa 1 track: tải async từ metadata file, placeholder khi không có.
struct TrackArtworkView: View {
    @EnvironmentObject var art: CoverArtManager
    let track: Track

    @State private var image: UIImage? = nil

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "music.note")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 44, height: 44)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: track.id) {
            image = await art.artwork(for: track)
        }
    }
}
